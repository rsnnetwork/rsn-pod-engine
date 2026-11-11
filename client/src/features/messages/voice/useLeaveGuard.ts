// While a voice note is being recorded, or one is stopped and not sent, closing or reloading the tab asks first (the
// browser's own "Leave site?"). A note lives in this tab's memory only, so leaving would lose it; it is never moved to
// another conversation instead. Moving between conversations or pages inside REASON does not ask: the note waits in
// its own conversation. iOS Safari does not honour beforeunload: there a reload drops an unsent note without asking.

import { useEffect } from 'react';
import { anyUnsentVoice, useComposerDrafts } from './composer-drafts';

export function useLeaveGuard(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Older Chrome and Safari show the prompt only when returnValue is set.
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [active]);
}

/** The app shell's guard: any voice note the signed-in member has not sent, on whatever page they are. */
export function useUnsentVoiceGuard(myUserId: string | null | undefined): void {
  useLeaveGuard(useComposerDrafts((s) => anyUnsentVoice(s, myUserId)));
}
