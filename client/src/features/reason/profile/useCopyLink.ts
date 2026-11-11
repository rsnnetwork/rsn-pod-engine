// client/src/features/reason/profile/useCopyLink.ts
// Copy one of your profile links and say so (Shirley pilot S6). Where the page may not write to the clipboard (an
// older iPhone, a page that is not secure), the phone's own share sheet is offered instead; only when that is missing
// too does the toast say it could not be copied.
import { useCallback } from 'react';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { copyText } from '@/lib/copy-text';
import { SHARE_WORDS, memberLinkFor } from './share-text';

export function useCopyLink() {
  const addToast = useToastStore((s) => s.addToast);
  return useCallback(async (url: string, copied: string) => {
    if (await copyText(url)) {
      addToast(copied, 'success');
      return;
    }
    try {
      if (navigator.share) {
        await navigator.share({ url });
        return;
      }
    } catch (err) {
      // The member closed the share sheet: that is their answer, and nothing failed.
      if ((err as { name?: string } | null)?.name === 'AbortError') return;
    }
    addToast(SHARE_WORDS.copyFailed, 'error');
  }, [addToast]);
}

/** "Copy link" for your member link, from the account menu and Your profile. */
export function useCopyMemberLink() {
  const me = useAuthStore((s) => s.user?.id as string | undefined);
  const copy = useCopyLink();
  return useCallback(async () => {
    if (!me) return;
    await copy(memberLinkFor(window.location.origin, me), SHARE_WORDS.memberCopied);
  }, [copy, me]);
}
