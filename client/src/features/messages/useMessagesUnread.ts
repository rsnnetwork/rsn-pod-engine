// client/src/features/messages/useMessagesUnread.ts
// How many messages are unread: one-to-one messages from others, plus every group's unread (26 Oct 2026, C12). The
// Messages badge in the shell and the browser tab's "(N) REASON" (30 Oct 2026, L8) read this one number, so the two
// never disagree. The same query keys as before, so the shell and the tab title share their reads.
import { useQuery } from '@tanstack/react-query';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { useAuthStore } from '@/stores/authStore';
import { useGroupUnreadTotal } from './useGroups';

export function useMessagesUnread(): number {
  const userId = useAuthStore((s) => s.user?.id as string | undefined);
  const { data: unread } = useQuery({
    queryKey: ['dm-unread-count'],
    queryFn: () => api.get('/dm/unread-count').then((r) => r.data.data.count as number),
    enabled: !!userId,
    meta: { entities: userId ? [E.userDms(userId)] : [] },
  });
  const groupUnread = useGroupUnreadTotal();
  return userId ? (unread ?? 0) + groupUnread : 0;
}
