// ─── A circle's writes, for its list and its page (T14, 1 Nov 2026) ──────────────────────────────────────────────
// Join, ask, withdraw an ask and leave go through one hook so the two screens say the same things. Each write reads
// the circle and the lists again at once on the actor's own screen (instant feedback); every other screen, and this
// one too, hears the server's circle tags (circle:<id>, user:<id>:circles, circle:<id>:requests) and refetches.
import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { CircleJoinPolicy } from '@rsn/shared';
import api from '@/lib/api';
import { CONNECTION_LOST, memberSentence } from '@/features/reason/errors';
import { useToastStore } from '@/stores/toastStore';
import { joinToast, type CircleAction } from './circle-logic';

const FAILED = "That didn't work. Try again.";

/** The server's own sentence for a refusal a member can read (closed circle, already answered), else `fallback`. */
export function circleErrorSentence(err: unknown, fallback = FAILED): string {
  const failed = err as { response?: { data?: { error?: { message?: unknown } } }; request?: unknown } | null;
  if (failed && !failed.response && failed.request) return CONNECTION_LOST;
  return memberSentence(failed?.response?.data?.error?.message) ?? fallback;
}

/** The circle's page, every circle list, and (for its managers) its asks, read again on this screen. */
export function refreshCircle(qc: QueryClient, circleId: string): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ['circle', circleId] }),
    qc.invalidateQueries({ queryKey: ['circle-requests', circleId] }),
    qc.invalidateQueries({ queryKey: ['circles'] }),
  ]);
}

const CALLS: Record<CircleAction, (id: string) => Promise<{ data?: { data?: { status?: string } } }>> = {
  join: (id) => api.post(`/circles/${id}/join`),
  request: (id) => api.post(`/circles/${id}/request`),
  cancel: (id) => api.delete(`/circles/${id}/request`),
  leave: (id) => api.post(`/circles/${id}/leave`),
};

/** The button's call: join, ask, withdraw the ask, or leave, with its toast. */
export function useCircleMembership() {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  return useMutation({
    networkMode: 'always',
    mutationFn: async ({ circleId, action }: { circleId: string; name: string; action: CircleAction }) =>
      (await CALLS[action](circleId)).data?.data,
    onSuccess: async (answer, { circleId, name, action }) => {
      await refreshCircle(qc, circleId);
      addToast(joinToast(action, name, answer), 'success');
    },
    onError: async (err, { circleId }) => {
      addToast(circleErrorSentence(err), 'error');
      // A circle closed since the page was read answers 403: read it again so the button says Ask to join.
      await refreshCircle(qc, circleId);
    },
  });
}

/** Who can join: the managers' setting. */
export function useJoinPolicy(circleId: string) {
  const qc = useQueryClient();
  return useMutation({
    networkMode: 'always',
    mutationFn: (joinPolicy: CircleJoinPolicy) => api.patch(`/circles/${circleId}`, { joinPolicy }),
    onSuccess: () => refreshCircle(qc, circleId),
  });
}

/** Approve or decline one ask. */
export function useAnswerRequest(circleId: string) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  return useMutation({
    networkMode: 'always',
    mutationFn: ({ userId, verb }: { userId: string; name: string; verb: 'approve' | 'decline' }) =>
      api.post(`/circles/${circleId}/requests/${userId}/${verb}`),
    onSuccess: async (_res, { name, verb }) => {
      await refreshCircle(qc, circleId);
      addToast(verb === 'approve' ? `${name} is in.` : `You declined ${name}'s request.`, 'success');
    },
    onError: async (err) => {
      addToast(circleErrorSentence(err), 'error');
      await refreshCircle(qc, circleId);
    },
  });
}
