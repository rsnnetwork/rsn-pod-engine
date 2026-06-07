// PURE logic for the event-scoped background engine (no livekit / DOM imports,
// so the server jest suite tests it directly — same pattern as bgFrameHealth).
//
// Why this exists (2026-06-07 prod measurements, docs/superpowers/plans/
// 2026-06-07-bg-architectural-fix.md): the old per-room hook raced a hard 8s
// timeout against track.setProcessor(). On slow devices the attach LOST the race
// but still completed later — the app forgot about a live pipeline, the next
// click built a second one, and the UI disagreed with reality ("clicked, nothing
// happened, browser got heavy"). This queue makes that impossible:
//   • exactly one pipeline op in flight, ever (serialization invariant)
//   • latest-wins — rapid clicks collapse to the final choice
//   • state reconciles to each op's ACTUAL outcome, however late it lands
//   • one watchdog for genuinely hung ops → executor drops the wedged pipeline
import type { BgPreference } from './bgPreference';

export type EnabledBgPreference = Exclude<BgPreference, { mode: 'disabled' }>;

// ── Adaptive quality (Zoom-style device classes) ────────────────────────────

export interface BgProfileInput {
  isMobile: boolean;
  cores: number;
  deviceMemoryGB: number;
  /** MediaStreamTrackProcessor/Generator available (Chrome/Edge). When false the
   *  library falls back to a main-thread RAF + canvas.captureStream loop
   *  (Safari) — markedly heavier, so it gets the lightest profile. */
  modernApi: boolean;
}

export interface BgProfile {
  maxFps: number;
  reducedFps: number;
}

export function pickBgProfile(i: BgProfileInput): BgProfile {
  if (!i.modernApi) return { maxFps: 8, reducedFps: 5 };
  if (i.isMobile) return { maxFps: 10, reducedFps: 7 };
  if (i.cores <= 4 || i.deviceMemoryGB <= 4) return { maxFps: 12, reducedFps: 8 };
  return { maxFps: 15, reducedFps: 10 };
}

// ── Apply queue ──────────────────────────────────────────────────────────────

/** The impure shell implements these against livekit + track-processors. */
export interface ApplyExecutor {
  /** true while a processor is attached to the camera track */
  hasPipeline(): boolean;
  /** dispose a wedged pipeline after a watchdog hard-fail (best effort) */
  dropPipeline(): void;
  /** create + attach a pipeline showing `pref` ('disabled' = warm passthrough) */
  build(pref: BgPreference): Promise<void>;
  /** retarget the live pipeline (image/blur/disabled passthrough) */
  switchTo(pref: BgPreference): Promise<void>;
}

export interface ApplyQueueState {
  applying: boolean;
  currentPref: BgPreference;
  desiredPref: BgPreference;
}

export interface ApplyQueueHooks {
  onStateChange?: (s: ApplyQueueState) => void;
  /** recoverable op failure (state rolled back) */
  onError?: (err: unknown, pref: BgPreference) => void;
  /** watchdog fired — the op hung outright */
  onHardFail?: (err: unknown, pref: BgPreference) => void;
}

export type ApplyResult = 'applied' | 'superseded' | 'failed';

export interface ApplyQueue {
  request(pref: BgPreference): Promise<ApplyResult>;
  /** Build a warm passthrough pipeline ahead of the first apply (panel open).
   *  No visible change; no-op if a pipeline exists or an op is in flight. */
  prewarm(): Promise<void>;
  /** The shell disposed the pipeline outside the queue (track died, device
   *  gave up): reality is now the raw camera — reset current so a re-apply of
   *  the same pref builds fresh instead of no-opping. */
  notePipelineLost(): void;
  state(): ApplyQueueState;
}

const DISABLED: BgPreference = { mode: 'disabled' };

/** Generous: covers a cold MediaPipe build on a slow device (measured 3.5–8.8s
 *  on a fast one). Only a genuinely hung WASM worker should ever hit this. */
export const BG_APPLY_WATCHDOG_MS = 20_000;

const sameImage = (a: BgPreference, b: BgPreference) =>
  a.mode === 'image' && b.mode === 'image' && a.imageUrl === b.imageUrl;

export const samePref = (a: BgPreference, b: BgPreference): boolean =>
  a.mode === b.mode && (a.mode !== 'image' || sameImage(a, b));

class WatchdogError extends Error {
  constructor() { super('bg_apply_watchdog'); }
}

export function createApplyQueue(
  exec: ApplyExecutor,
  hooks: ApplyQueueHooks = {},
  opts: { watchdogMs?: number } = {},
): ApplyQueue {
  const watchdogMs = opts.watchdogMs ?? BG_APPLY_WATCHDOG_MS;

  let current: BgPreference = DISABLED;
  let desired: BgPreference = DISABLED;
  let applying = false;
  let running = false;
  // Pending callers keyed by the pref they asked for; resolved on land/supersede.
  let waiters: Array<{ pref: BgPreference; resolve: (r: ApplyResult) => void }> = [];

  const snapshot = (): ApplyQueueState => ({ applying, currentPref: current, desiredPref: desired });
  const notify = () => hooks.onStateChange?.(snapshot());

  const settle = (landed: BgPreference | null, failed: boolean) => {
    const rest: typeof waiters = [];
    for (const w of waiters) {
      if (landed && samePref(w.pref, landed)) w.resolve(failed ? 'failed' : 'applied');
      else if (samePref(w.pref, desired)) rest.push(w); // still in play
      else w.resolve('superseded');
    }
    waiters = rest;
  };

  const withWatchdog = async (p: Promise<void>): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        p,
        new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new WatchdogError()), watchdogMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const pump = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      while (!samePref(desired, current)) {
        const target = desired;
        // Disabled with no pipeline: nothing to do — it IS the raw camera.
        if (target.mode === 'disabled' && !exec.hasPipeline()) {
          current = target;
          settle(target, false);
          notify();
          continue;
        }
        applying = true;
        notify();
        try {
          if (exec.hasPipeline()) {
            await withWatchdog(exec.switchTo(target));
          } else {
            await withWatchdog(exec.build(target));
          }
          current = target;
          settle(target, false);
        } catch (err) {
          if (err instanceof WatchdogError) {
            // The op is wedged — the underlying promise may still resolve some
            // day, but the pipeline can't be trusted. Drop it so the next apply
            // starts clean (this is what kills the orphaned-processor class).
            try { exec.dropPipeline(); } catch { /* best effort */ }
            hooks.onHardFail?.(err, target);
          } else {
            hooks.onError?.(err, target);
          }
          // Roll back: stop wanting the thing that failed (unless the user
          // already asked for something newer — then the loop continues to it).
          if (samePref(desired, target)) desired = current;
          settle(target, true);
        } finally {
          applying = false;
          notify();
        }
      }
    } finally {
      running = false;
      // Anyone still waiting wants what is now current (raced the final lap).
      settle(current, false);
    }
  };

  return {
    state: snapshot,
    notePipelineLost(): void {
      current = DISABLED;
      if (samePref(desired, current)) notify();
      else void pump();
    },
    async prewarm(): Promise<void> {
      if (running || exec.hasPipeline()) return;
      running = true;
      try {
        await withWatchdog(exec.build(DISABLED));
      } catch (err) {
        if (err instanceof WatchdogError) {
          try { exec.dropPipeline(); } catch { /* best effort */ }
          hooks.onHardFail?.(err, DISABLED);
        } else {
          hooks.onError?.(err, DISABLED);
        }
      } finally {
        running = false;
      }
      // A click may have landed while we were warming — serve it now (pump also
      // drains any waiters whose pref already matches current).
      void pump();
    },
    request(pref: BgPreference): Promise<ApplyResult> {
      if (samePref(pref, current) && !running) {
        desired = pref;
        return Promise.resolve('applied');
      }
      desired = pref;
      notify();
      return new Promise<ApplyResult>((resolve) => {
        waiters.push({ pref, resolve });
        void pump();
      });
    },
  };
}
