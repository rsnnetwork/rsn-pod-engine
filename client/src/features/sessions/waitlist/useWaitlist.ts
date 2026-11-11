// client/src/features/sessions/waitlist/useWaitlist.ts
// Part 3 Task 8: the waiting list's reads and writes on the event page, through lib/api.ts.
//
// The organisers' list follows the line (session:<id>:waitlist, sent on every join, leave, removal, admission and
// promotion) and the event's places (session:<id>:participants). Every write then lets those tags, and a plain
// invalidation of the reads this page holds, bring the screens up to date: nothing is written into a cached answer.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WaitlistEntryCard } from '@rsn/shared';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { useToastStore } from '@/stores/toastStore';
import { WAITLIST_COPY, notForThisViewer, waitlistFailure } from './waitlist-text';

/** The line, in order, for the people who run the event (the server refuses anyone else: 403). */
export function useWaitlistLine(sessionId: string, enabled: boolean) {
  return useQuery<WaitlistEntryCard[]>({
    queryKey: ['session-waitlist', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}/waitlist`).then((r) => r.data.data ?? []),
    enabled: enabled && sessionId.length > 0,
    retry: (count, err: unknown) => !notForThisViewer(err) && count < 2,
    meta: { entities: [E.sessionWaitlist(sessionId), E.sessionParticipants(sessionId)] },
  });
}

/** The reads a change to the line or to the places can move on this page. */
function useRefreshEvent(sessionId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['session-waitlist', sessionId] });
    void qc.invalidateQueries({ queryKey: ['session-participants', sessionId] });
    void qc.invalidateQueries({ queryKey: ['session-participant-counts', sessionId] });
    void qc.invalidateQueries({ queryKey: ['session', sessionId] });
  };
}

/** The organisers' "Let in now" (a place over capacity) and "Remove" (off the line). */
export function useWaitlistActions(sessionId: string) {
  const addToast = useToastStore((s) => s.addToast);
  const refresh = useRefreshEvent(sessionId);

  const admit = useMutation({
    mutationFn: (row: WaitlistEntryCard) => api.post(`/sessions/${sessionId}/waitlist/${row.userId}/admit`),
    onSuccess: (_res, row) => addToast(WAITLIST_COPY.letInDone(row.displayName), 'success'),
    onError: (err) => addToast(waitlistFailure(err), 'error'),
    onSettled: refresh,
  });

  const remove = useMutation({
    mutationFn: (row: WaitlistEntryCard) => api.delete(`/sessions/${sessionId}/waitlist/${row.userId}`),
    onSuccess: (_res, row) => addToast(WAITLIST_COPY.removedToast(row.displayName), 'success'),
    onError: (err) => addToast(waitlistFailure(err), 'error'),
    onSettled: refresh,
  });

  return { admit, remove };
}

/** The person's own "Leave the waiting list" on the event page. */
export function useLeaveWaitlist(sessionId: string) {
  const addToast = useToastStore((s) => s.addToast);
  const refresh = useRefreshEvent(sessionId);
  return useMutation({
    mutationFn: () => api.delete(`/sessions/${sessionId}/waitlist/mine`),
    onSuccess: () => addToast(WAITLIST_COPY.leftToast, 'info'),
    onError: (err) => addToast(waitlistFailure(err), 'error'),
    onSettled: refresh,
  });
}
