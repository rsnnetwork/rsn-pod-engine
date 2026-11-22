// client/src/features/admin/users/useProfileBadge.ts
// Giving or taking away a member's badge from the admin Users page (Shradha, 21 Nov 2026: "can we update a premium
// badge to them?"): one row's button, or every selected row from the bulk bar. Display only: it is never the
// is_premium flag, which changes live-event matching. The list redraws on the refetch (admin:users reaches every
// admin's open list), and the member's own screens and the people around them through their tags.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ProfileBadgeKind } from '@rsn/shared';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';
import { failureText } from './user-status';

export interface BadgeChange {
  userIds: string[];
  badge: ProfileBadgeKind | null;
  /** Who the toast names: a member's name for one row, or null for a selection. */
  name: string | null;
}

/** What a change says when it went through, in a sentence. */
export function badgeDoneText({ userIds, badge, name }: BadgeChange): string {
  const who = name ?? (userIds.length === 1 ? '1 person' : `${userIds.length} people`);
  if (badge) return name || userIds.length === 1 ? `${who} has the Premium badge now.` : `${who} have the Premium badge now.`;
  return `The Premium badge was taken off ${who}.`;
}

/** `onDone` runs after a change went through, `onSettled` after any answer (the bulk bar closes its dialog then). */
export function useProfileBadge({ onDone, onSettled }: { onDone?: () => void; onSettled?: () => void } = {}) {
  const queryClient = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const mutation = useMutation({
    mutationFn: ({ userIds, badge }: BadgeChange) => api.put('/admin/users/profile-badge', { userIds, badge }),
    onSuccess: (_res, change) => {
      addToast(badgeDoneText(change), 'success');
      onDone?.();
    },
    onError: (err) => addToast(failureText(err), 'error'),
    onSettled: () => {
      onSettled?.();
      void queryClient.invalidateQueries({ queryKey: ['admin-users'] });
    },
  });
  /** True while a change that includes this member is on its way. */
  const busyFor = (userId: string) => mutation.isPending && !!mutation.variables?.userIds.includes(userId);
  return { change: (c: BadgeChange) => { if (!mutation.isPending) mutation.mutate(c); }, busyFor, pending: mutation.isPending };
}
