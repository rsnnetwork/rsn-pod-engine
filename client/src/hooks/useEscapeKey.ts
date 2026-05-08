// ─── useEscapeKey ──────────────────────────────────────────────────────────
//
// Phase 8B.2 (8 May spec) — Stefan #4 + #6: every modal closeable by Esc.
// Pre-fix the Invite modal, Room creation modal, HCC Move-to-room
// sub-modal, and HCC windowed mode all trapped users — clicking outside
// closed some, but Esc never closed any. Stefan reported this as
// "controls freeze, clicks stop responding" because the keyboard
// shortcut every web user expects didn't work.
//
// The hook attaches a single keydown listener on document and only fires
// `onEscape` when `isOpen` is true. Cleans up on unmount or when the
// modal closes.

import { useEffect } from 'react';

export function useEscapeKey(onEscape: () => void, isOpen: boolean): void {
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onEscape();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onEscape, isOpen]);
}
