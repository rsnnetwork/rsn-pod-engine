import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';
import type {
  BroadcastEligibility,
  PostEventMessagePreview,
  PostEventMessageJob,
} from '@rsn/shared';

// ─── Query key factories ───────────────────────────────────────────────────────

const keys = {
  eligibility: (sessionId: string) =>
    ['post-event-message', 'eligibility', sessionId] as const,
  status: (sessionId: string) =>
    ['post-event-message', 'status', sessionId] as const,
  preview: (sessionId: string) =>
    ['post-event-message', 'preview', sessionId] as const,
};

// ─── Hooks ────────────────────────────────────────────────────────────────────

/** Check whether the current user can send post-event messages for this event. */
export function useBroadcastEligibility(sessionId: string) {
  return useQuery<BroadcastEligibility>({
    queryKey: keys.eligibility(sessionId),
    queryFn: () =>
      api
        .get(`/sessions/${sessionId}/post-event-message/eligibility`)
        .then((r) => r.data.data),
    enabled: !!sessionId,
  });
}

/** Poll the job status while the job is active; stop polling once settled. */
export function usePostEventMessageStatus(sessionId: string) {
  return useQuery<PostEventMessageJob | null>({
    queryKey: keys.status(sessionId),
    queryFn: () =>
      api
        .get(`/sessions/${sessionId}/post-event-message/status`)
        .then((r) => r.data.data),
    enabled: !!sessionId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'pending' || status === 'processing' ? 5000 : false;
    },
  });
}

/**
 * Dry-run preview of who would receive messages.
 * Only fetches when `enabled` is true (e.g. confirm modal is open).
 */
export function usePostEventMessagePreview(sessionId: string, enabled: boolean) {
  return useQuery<PostEventMessagePreview>({
    queryKey: keys.preview(sessionId),
    queryFn: () =>
      api
        .get(`/sessions/${sessionId}/post-event-message/preview`)
        .then((r) => r.data.data),
    enabled: !!sessionId && enabled,
  });
}

/** Trigger the broadcast. On success, start polling the status query. */
export function useSendPostEventMessages(sessionId: string) {
  const qc = useQueryClient();
  const { addToast } = useToastStore();

  return useMutation<PostEventMessageJob, unknown, void>({
    mutationFn: () =>
      api
        .post(`/sessions/${sessionId}/post-event-message`)
        .then((r) => r.data.data),
    onSuccess: (data) => {
      addToast(
        `Messages are being sent to ${data.totalRecipients} participants`,
        'success',
      );
      qc.invalidateQueries({ queryKey: keys.status(sessionId) });
    },
    onError: (err: any) => {
      const msg =
        err?.response?.data?.error?.message ||
        'Failed to send post-event messages';
      addToast(msg, 'error');
    },
  });
}
