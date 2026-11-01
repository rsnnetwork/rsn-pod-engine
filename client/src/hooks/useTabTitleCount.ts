// client/src/hooks/useTabTitleCount.ts
// "(N) REASON" in the browser tab while messages are unread (30 Oct 2026 review, item 4.4, L8). Mounted once in App.tsx,
// so it holds on every signed-in page, the profile and the meeting room included (they are outside the shell). It reads
// the very number the Messages badge shows (useMessagesUnread), which the server's tags keep live. Signed out, the tab
// reads "REASON" again.
import { useEffect } from 'react';
import { useMessagesUnread } from '@/features/messages/useMessagesUnread';
import { tabTitle } from '@/lib/tab-title';

export function useTabTitleCount(): void {
  const unread = useMessagesUnread();
  useEffect(() => {
    document.title = tabTitle(unread);
  }, [unread]);
}
