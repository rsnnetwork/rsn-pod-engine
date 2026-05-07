// ─── useActionLock ──────────────────────────────────────────────────────────
//
// Phase 7B.3 (7 May spec) — Stefan #10: "you have to press it twice".
// Pre-fix, host action buttons had no lock against double-clicks. A user
// who clicked Confirm Round / Begin Round / End Event twice could fire
// the socket event twice, either causing duplicate server work or just
// confusing the host who thought the first click missed.
//
// This hook returns a `runLocked(key, fn)` helper. While a key is locked
// (default 1500ms after first invocation), subsequent calls with the
// same key are ignored. Buttons consult `isLocked(key)` to render their
// disabled / loading state, so the host gets immediate visual feedback
// AND the network can't be hit twice.
//
// Generic by key — apply the same hook across every host action button
// without per-button state plumbing.
//
// Phase 7-audit fix — ref-backed gate. Pre-fix the gate read from the
// closed-over `locked` Set inside useCallback, so two clicks fired in
// the same render frame both saw an empty Set and both passed. The
// state copy is kept in sync for component-level disabled wiring; the
// ref is the source of truth for the gate.

import { useCallback, useRef, useState } from 'react';

const DEFAULT_LOCK_MS = 1500;

export function useActionLock(lockMs: number = DEFAULT_LOCK_MS) {
  const lockedRef = useRef<Set<string>>(new Set());
  const [lockedSet, setLockedSet] = useState<Set<string>>(new Set());

  const runLocked = useCallback(
    (key: string, fn: () => void | Promise<void>): void => {
      if (lockedRef.current.has(key)) return;
      lockedRef.current.add(key);
      setLockedSet((prev) => {
        if (prev.has(key)) return prev;
        const next = new Set(prev);
        next.add(key);
        return next;
      });
      const release = () => {
        lockedRef.current.delete(key);
        setLockedSet((prev) => {
          if (!prev.has(key)) return prev;
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      };
      try {
        const result = fn();
        if (result && typeof (result as Promise<void>).then === 'function') {
          (result as Promise<void>).finally(() => {
            window.setTimeout(release, lockMs);
          });
        } else {
          window.setTimeout(release, lockMs);
        }
      } catch {
        window.setTimeout(release, lockMs);
      }
    },
    [lockMs],
  );

  const isLocked = useCallback((key: string) => lockedSet.has(key), [lockedSet]);

  return { runLocked, isLocked };
}
