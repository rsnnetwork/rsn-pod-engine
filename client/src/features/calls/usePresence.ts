// client/src/features/calls/usePresence.ts
// Where the people a member may call are now (11 Nov 2026, Shirley Palmer's RSN 07). No polling: each read declares the
// person's `user:<id>:presence` tag, which the server sends the moment they come online, step away or go offline, and
// every tagged read is read again after a reconnect. A block hides presence both ways, so the member's own blocks tag
// is declared too.
//
// The inbox and the thread header read ONE query (GET /dm/presence), so the dot in the list and the word in the
// header can never disagree. A profile, which knows a person and not a conversation, reads that person alone.
import { useQuery } from '@tanstack/react-query';
import type { PresenceState } from '@rsn/shared';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { shouldRetry } from '@/features/reason/human/profile-text';
import type { InboxPresence } from './presence-words';

export const inboxPresenceKey = ['dm-inbox-presence'] as const;

/** Every conversation partner's presence. `partnerIds` are the people on screen, whose changes refresh it. */
export function useInboxPresence(myUserId: string | undefined, partnerIds: readonly string[]) {
  return useQuery({
    queryKey: inboxPresenceKey,
    queryFn: () => api.get('/dm/presence').then((r) => r.data.data as InboxPresence),
    enabled: !!myUserId,
    refetchOnWindowFocus: true,
    retry: shouldRetry,
    meta: {
      entities: myUserId
        ? [E.userDms(myUserId), E.userBlocks(myUserId), ...partnerIds.map((id) => E.userPresence(id))]
        : [],
    },
  });
}

/** One connection's presence, for the call button on their profile (only asked when the two can call). */
export function useMemberPresence(myUserId: string | undefined, userId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['member-presence', userId],
    queryFn: () => api.get(`/calls/user/${encodeURIComponent(userId)}/presence`)
      .then((r) => (r.data.data as { state: PresenceState | null }).state),
    enabled: enabled && !!myUserId,
    refetchOnWindowFocus: true,
    retry: shouldRetry,
    meta: { entities: myUserId ? [E.userPresence(userId), E.userBlocks(myUserId)] : [] },
  });
}
