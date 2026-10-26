import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { useAuthStore } from '@/stores/authStore';
import type { BroadcastEligibilityV2, PostEventMessageJob, PostEventMessageSendRequest } from '@rsn/shared';

// ─── Message everyone who took part, version 2 (26 Oct 2026, C10, COM-03) ────
//
// The server (S6) lets the people who run an event (its host, co-hosts, the pod's director or host) and admins write
// their own words to everyone who took part once it has ended, and says where things stand as a sentence. It tells
// the people who run the event as a send goes out (the event's tag, when it starts, after every batch, at the end),
// so nothing here polls: these queries follow the event's tag like every other query on its page.

const keys = {
  eligibility: (sessionId: string) => ['post-event-message', 'eligibility', 'v2', sessionId] as const,
  status: (sessionId: string) => ['post-event-message', 'status', sessionId] as const,
};

/** Whether this member may message everyone on this event now, and if not, why (version 2). */
export function useBroadcastEligibilityV2(sessionId: string) {
  const myUserId = useAuthStore((s) => s.user?.id);
  return useQuery<BroadcastEligibilityV2>({
    queryKey: keys.eligibility(sessionId),
    queryFn: () =>
      api.get(`/sessions/${sessionId}/post-event-message/eligibility`, { params: { v: 2 } }).then((r) => r.data.data),
    enabled: !!sessionId,
    // The send's progress and its end arrive as the event's tag; who took part is the event's participants; who may
    // send follows the member's own role and the pods they run.
    meta: {
      entities: sessionId
        ? [E.session(sessionId), E.sessionParticipants(sessionId), ...(myUserId ? [E.user(myUserId), E.userPods(myUserId)] : [])]
        : [],
    },
  });
}

/** The event's latest send. Only the people who run the event may read it, so it is asked for only for them. */
export function usePostEventMessageStatus(sessionId: string, enabled: boolean) {
  return useQuery<PostEventMessageJob | null>({
    queryKey: keys.status(sessionId),
    queryFn: () => api.get(`/sessions/${sessionId}/post-event-message/status`).then((r) => r.data.data ?? null),
    enabled: !!sessionId && enabled,
    meta: { entities: sessionId ? [E.session(sessionId)] : [] },
  });
}

/** Send the organiser's own words. A refusal is the caller's to show, beside the message (sendErrorSentence). */
export function useSendPostEventMessage(sessionId: string) {
  const qc = useQueryClient();
  return useMutation<PostEventMessageJob, unknown, PostEventMessageSendRequest>({
    mutationFn: (input) => api.post(`/sessions/${sessionId}/post-event-message`, input).then((r) => r.data.data),
    // The server tells the event's organisers too; the sender's own panel moves to "Sending…" at once.
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.eligibility(sessionId) });
      qc.invalidateQueries({ queryKey: keys.status(sessionId) });
    },
  });
}
