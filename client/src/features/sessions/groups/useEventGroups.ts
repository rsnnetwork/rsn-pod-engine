// ─── An event's matching groups: the read and the two writes (Part 2 Task 11 over Task 5's routes) ──────────────────
// The read follows session:<id>:groups (every groups write and a registration with a group send it) and
// session:<id>:participants (a person taking or leaving a place moves the counts and who has no group yet).
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { EventGroupRules, EventGroupsView } from '@rsn/shared';
import api from '@/lib/api';
import { E } from '@/realtime/entities';

export const groupsKey = (sessionId: string) => ['session-groups', sessionId] as const;

export function useEventGroups(sessionId: string, enabled = true) {
  return useQuery<EventGroupsView>({
    queryKey: groupsKey(sessionId),
    queryFn: () => api.get(`/sessions/${sessionId}/groups`).then((r) => r.data.data as EventGroupsView),
    enabled,
    retry: (count, err: unknown) => {
      const status = (err as { response?: { status?: number } })?.response?.status;
      // Review I2: never a 429, whose re-read waits for the limit's window (realtime/rate-limited-reads.ts).
      return status !== 403 && status !== 404 && status !== 429 && count < 2;
    },
    meta: { entities: [E.sessionGroups(sessionId), E.sessionParticipants(sessionId)] },
  });
}

export function useSaveEventGroups(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    networkMode: 'always',
    mutationFn: (rules: EventGroupRules) => api.put(`/sessions/${sessionId}/groups`, {
      groups: rules.groups.map((g) => ({ key: g.key, label: g.label, description: g.description ?? null })),
      question: rules.question,
      allowMultiple: rules.allowMultiple,
      fallback: rules.fallback,
      rounds: rules.rounds,
      // Left out unless the owner is choosing it: the server then keeps the stored choice.
      ...(rules.overrideBy ? { overrideBy: rules.overrideBy } : {}),
    }).then((r) => r.data.data as EventGroupRules),
    // Returned, so the mutation stays pending until the refetch has landed: a screen reading the saved value never flips back.
    onSuccess: () => qc.invalidateQueries({ queryKey: groupsKey(sessionId) }),
  });
}

export function useSetParticipantGroups(sessionId: string) {
  const qc = useQueryClient();
  return useMutation({
    networkMode: 'always',
    mutationFn: ({ userId, groupKeys }: { userId: string; groupKeys: string[] }) =>
      api.put(`/sessions/${sessionId}/participants/${userId}/groups`, { groupKeys }),
    // Returned, so the mutation stays pending until the refetch has landed: a screen reading the saved value never flips back.
    onSuccess: () => qc.invalidateQueries({ queryKey: groupsKey(sessionId) }),
  });
}
