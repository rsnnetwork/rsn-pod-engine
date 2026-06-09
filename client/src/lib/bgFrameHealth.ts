// Background-effects frame-health degradation — PURE logic, zero imports, so it
// can be unit-tested directly (the rest of backgroundEffects.ts pulls in
// livekit-client and the lazy MediaPipe module, which a unit test can't load).
//
// Why this exists: @livekit/track-processors v0.7.2 runs MediaPipe segmentation
// on the MAIN THREAD (RAF loop) — a sustained-slow device can jank/freeze the
// tab. We watch per-frame processing time and step the effect down, then off,
// so the browser can never be held hostage by the background effect. The render
// loop already DROPS frames when behind (it grabs the latest frame and skips the
// rest), so there is no queue/memory-balloon risk — this guards CPU/GPU time.

/** 15fps target → ~66ms budget per processed frame. */
export const BG_MAX_FPS = 15;
/** When we step down once before giving up. */
export const BG_REDUCED_MAX_FPS = 10;
export const BG_FRAME_BUDGET_MS = 1000 / BG_MAX_FPS; // 66.6
/** ~3s window at 15fps. */
export const BG_HEALTH_WINDOW = 45;
/** Sustained breach: >30% of frames over budget across the window ⇒ degrade. */
export const BG_BREACH_RATIO = 0.3;
/** Catastrophic single frame ⇒ kill immediately (true never-freeze backstop). */
export const BG_WATCHDOG_MS = 250;
/** Ignore the first frames after a processor starts — MediaPipe model load,
 *  shader compile and the first inference are always slow even on fast GPUs, and
 *  must not trip the watchdog/ladder and disable the effect at cold start. */
export const BG_WARMUP_FRAMES = 20;

export type FrameHealthAction = 'ok' | 'reduce' | 'disable';

/**
 * Pure ladder decision. One-shot and monotonic: ok → reduce → disable. It never
 * recovers on its own, which is deliberate — auto-recovery would flap the effect
 * on/off as load oscillates. Once degraded the user decides when to re-enable.
 */
export function evaluateFrameHealth(
  breachRatio: number,
  state: { reduced: boolean },
): FrameHealthAction {
  if (breachRatio <= BG_BREACH_RATIO) return 'ok';
  if (!state.reduced) return 'reduce';
  return 'disable';
}

export interface FrameStats {
  processingTimeMs: number;
}

/**
 * Stateful monitor fed by the processor's onFrameProcessed callback. Fires
 * onReduce once (step down to a lower fps) and onDisable once (turn the effect
 * off). A single frame past the watchdog disables immediately, bypassing the
 * window. Each handler fires at most once.
 */
export function createFrameHealthMonitor(handlers: {
  onReduce: () => void;
  onDisable: () => void;
  /** Start already stepped-down — the processor was rebuilt at reduced fps, so
   *  the next sustained breach should disable rather than reduce again. */
  startReduced?: boolean;
  /** Per-frame budget in ms. Defaults to the 15fps budget; PASS THE DEVICE'S
   *  ACTUAL target (1000 / profile.maxFps) so a mobile profile (8–10fps =
   *  100–125ms/frame) isn't judged against the 66ms 15fps budget — that
   *  mismatch false-disabled mobile backgrounds after a few seconds (Ali, 9 Jun). */
  budgetMs?: number;
  /** Single-frame catastrophic kill threshold. Defaults to BG_WATCHDOG_MS
   *  (250ms — tuned for the 15fps desktop budget). On a slower profile pass a
   *  larger value so one mobile jank spike doesn't nuke the effect. */
  watchdogMs?: number;
}): (stats: FrameStats) => void {
  const budget = handlers.budgetMs ?? BG_FRAME_BUDGET_MS;
  const watchdogMs = handlers.watchdogMs ?? BG_WATCHDOG_MS;
  const breaches: number[] = [];
  let reduced = handlers.startReduced ?? false;
  let finished = false;
  let total = 0;
  let catastrophic = 0; // consecutive watchdog-class frames

  return (stats: FrameStats) => {
    if (finished) return;

    // Warmup grace: the first frames (model load / shader compile / first
    // inference) are always slow — never let them disable the effect.
    total++;
    if (total <= BG_WARMUP_FRAMES) return;

    // Hard watchdog — kill on TWO consecutive catastrophic frames, not one.
    // A single >watchdog spike (a GC pause / a backgrounded mobile tab waking)
    // is normal jank; requiring two-in-a-row keeps the never-freeze guarantee
    // (the render loop already drops frames) while not flapping the effect off
    // on a momentary spike — the other half of the mobile-disappear fix.
    if (stats.processingTimeMs >= watchdogMs) {
      catastrophic++;
      if (catastrophic >= 2) {
        finished = true;
        handlers.onDisable();
      }
      return;
    }
    catastrophic = 0;

    breaches.push(stats.processingTimeMs > budget ? 1 : 0);
    if (breaches.length < BG_HEALTH_WINDOW) return;
    while (breaches.length > BG_HEALTH_WINDOW) breaches.shift();

    const breachRatio = breaches.reduce((a, b) => a + b, 0) / breaches.length;
    const action = evaluateFrameHealth(breachRatio, { reduced });

    if (action === 'reduce') {
      reduced = true;
      breaches.length = 0; // reset the window after stepping down
      handlers.onReduce();
    } else if (action === 'disable') {
      finished = true;
      handlers.onDisable();
    }
  };
}
