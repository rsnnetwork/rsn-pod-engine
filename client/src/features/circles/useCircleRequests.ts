// ─── Asking for a new circle: the member's side and the admins' queue (Ben field test, 13 Nov 2026) ────────────────
// The server is the source of truth: every list follows its entity tag (the member's user:<id>:circle-requests, the
// admins' admin:circle-requests), and each write invalidates the lists it changed so the screen that made it moves at
// once. No cache is written by hand.
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { CircleCreationRequest, CircleCreationRequestForReview, CircleJoinPolicy } from '@rsn/shared';
import api from '@/lib/api';
import { E } from '@/realtime/entities';

export interface CircleRequestValues {
  name: string;
  description: string;
  purpose: string;
  joinPolicy: CircleJoinPolicy;
}

const MINE = ['circle-requests', 'mine'] as const;
const QUEUE = ['circle-requests', 'queue'] as const;

function refreshRequests(qc: QueryClient): Promise<unknown> {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ['circle-requests'] }),
    qc.invalidateQueries({ queryKey: ['circles'] }),
  ]);
}

/** The member's own asks, newest first. */
export function useMyCircleRequests(userId: string | undefined) {
  return useQuery<CircleCreationRequest[]>({
    queryKey: MINE,
    queryFn: () => api.get('/circle-requests/mine').then((r) => r.data.data ?? []),
    enabled: !!userId,
    meta: { entities: userId ? [E.userCircleRequests(userId)] : [] },
  });
}

/** Ask for a new circle. */
export function useRequestCircle() {
  const qc = useQueryClient();
  return useMutation({
    networkMode: 'always',
    mutationFn: (values: CircleRequestValues) => api.post('/circle-requests', {
      name: values.name.trim(),
      description: values.description.trim() || null,
      purpose: values.purpose.trim(),
      joinPolicy: values.joinPolicy,
    }).then((r) => r.data.data as CircleCreationRequest),
    onSettled: () => refreshRequests(qc),
  });
}

/** Withdraw one of your own waiting asks. */
export function useWithdrawCircleRequest() {
  const qc = useQueryClient();
  return useMutation({
    networkMode: 'always',
    mutationFn: (requestId: string) => api.delete(`/circle-requests/${requestId}`),
    onSettled: () => refreshRequests(qc),
  });
}

/** The asks waiting for a platform admin's answer, oldest first. */
export function useCircleRequestQueue(enabled: boolean) {
  return useQuery<CircleCreationRequestForReview[]>({
    queryKey: QUEUE,
    queryFn: () => api.get('/circle-requests').then((r) => r.data.data ?? []),
    enabled,
    meta: { entities: [E.adminCircleRequests] },
  });
}

/** A platform admin approves (optionally under another name) or declines (optionally with a reason). */
export function useAnswerCircleRequest() {
  const qc = useQueryClient();
  return useMutation({
    networkMode: 'always',
    mutationFn: (answer: { requestId: string; approve: true; name?: string } | { requestId: string; approve: false; reason?: string }) =>
      answer.approve
        ? api.post(`/circle-requests/${answer.requestId}/approve`, answer.name ? { name: answer.name } : {})
          .then((r) => r.data.data as { circleId: string })
        : api.post(`/circle-requests/${answer.requestId}/decline`, answer.reason ? { reason: answer.reason } : {})
          .then(() => null),
    onSettled: () => refreshRequests(qc),
  });
}
