// client/src/features/reason/human/useBlockedByYou.ts
// A profile you blocked is closed to you: the brief answers 404 and the page says the profile is not available. The
// old public profile's Unblock lived on the profile itself, so once every people link opens the Human Profile a block
// could not be undone (21 Oct 2026). The notice now offers it, when you are the one who blocked. When the other member
// blocked you, nothing changes: the notice says only that the profile is not available, and never why.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useToastStore } from '@/stores/toastStore';
import { E } from '@/realtime/entities';
import { errorMessage, fetchBlockStatus, reasonKeys, unblockMember } from '../api';
import { shouldRetry } from './profile-text';
import { useConfirm } from '@/hooks/useConfirm';

// The old profile unblocked at once. A confirmation now asks first, in the same dialog Block uses (T2, 1 Nov 2026: a
// ConfirmDialog in the page; the page renders `confirmDialog`).
const UNBLOCK_TITLE = 'Unblock this member?';
const UNBLOCK_BODY = 'They will be able to message you again, and you may be matched together in future events.';

/** Asked only while the page shows "not available" for a member id: whether you blocked them, and Unblock. */
export function useBlockedByYou(userId: string, me: string | undefined, asking: boolean) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const { ask, confirmDialog } = useConfirm();
  const status = useQuery({
    queryKey: reasonKeys.blockStatus(userId),
    queryFn: () => fetchBlockStatus(userId),
    enabled: asking && !!me,
    retry: shouldRetry,
    // A block or an unblock, from this tab or any other, is user:<you>:blocks.
    meta: { entities: me ? [E.userBlocks(me)] : [] },
  });
  // networkMode 'always': offline, a press fails at once and says so. The refresh is returned, so Unblock stays busy
  // until the brief is back and the profile is on screen again.
  const unblock = useMutation({
    networkMode: 'always',
    mutationFn: () => unblockMember(userId),
    onSuccess: () => {
      addToast('Unblocked.', 'success');
      return qc.invalidateQueries({ queryKey: reasonKeys.all });
    },
    onError: (err) => addToast(errorMessage(err, 'Could not unblock right now. Try again in a moment.'), 'error'),
  });
  const askToUnblock = async () => {
    if (unblock.isPending) return;
    if (await ask({ title: UNBLOCK_TITLE, body: UNBLOCK_BODY, confirmLabel: 'Unblock' })) unblock.mutate();
  };
  return {
    /** The answer is on its way: the page waits for it rather than flash the plain notice first. */
    checking: status.isPending && status.fetchStatus === 'fetching',
    blockedByYou: status.data?.hasBlocked === true,
    askToUnblock,
    unblocking: unblock.isPending,
    confirmDialog,
  };
}
