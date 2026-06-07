// Thin React binding for the event-scoped background engine (lib/bgEngine).
// Both rooms render from the SAME engine state, so the panel highlight, the
// "Applying…" indicator and the degraded notice can never drift between the
// lobby and a breakout the way the old per-room hook instances could.
import { useCallback, useSyncExternalStore } from 'react';
import { getBgEngine, type BgEngineState, type BgPreference } from '@/lib/bgEngine';

export interface UseBgEngine extends BgEngineState {
  apply: (pref: BgPreference) => void;
  applyUpload: (file: Blob) => void;
  /** call when the BG panel opens — builds the pipeline while the user chooses */
  prewarm: () => void;
}

export function useBgEngine(): UseBgEngine {
  const engine = getBgEngine();
  const state = useSyncExternalStore(
    useCallback((cb) => engine.subscribe(cb), [engine]),
    () => engine.getState(),
  );
  return {
    ...state,
    apply: useCallback((pref: BgPreference) => { void engine.apply(pref); }, [engine]),
    applyUpload: useCallback((file: Blob) => { void engine.applyUpload(file); }, [engine]),
    prewarm: useCallback(() => engine.prewarmPipeline(), [engine]),
  };
}
