// ─── Pods inside pods: the reads and changes a pod's page makes (22 Nov 2026) ─────────────────────────────────────
// Every read declares its tags (the server sends pod:<id>:inner-pods, pod:<id> and user:<id>:pods when a pod is made
// inside, put in, taken out, renamed or archived, or when the members-only choice changes). A change also reads its own
// screen again at once, so the person who made it never waits for the socket.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { InnerPodCandidate, InnerPodItem } from '@rsn/shared';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { NESTED_TOAST, refusalSentence } from './nested-pods-view';

export function useInnerPods(podId: string, enabled: boolean) {
  return useQuery<InnerPodItem[]>({
    queryKey: ['pod-inner-pods', podId],
    queryFn: () => api.get(`/pods/${podId}/pods`).then((r) => r.data.data ?? []),
    enabled,
    meta: { entities: [E.podInnerPods(podId), E.pod(podId)] },
  });
}

export function useInnerPodCandidates(podId: string, enabled: boolean) {
  const me = useAuthStore((s) => s.user?.id);
  return useQuery<InnerPodCandidate[]>({
    queryKey: ['pod-inner-pod-candidates', podId],
    queryFn: () => api.get(`/pods/${podId}/pods/candidates`).then((r) => r.data.data ?? []),
    enabled,
    meta: { entities: [E.podInnerPods(podId), E.pod(podId), ...(me ? [E.userPods(me)] : [])] },
  });
}

/** Read again every screen a change of where a pod sits shows on: both pods, their pods inside, and the pods lists. */
function useNestingRefresh() {
  const qc = useQueryClient();
  return (podIds: Array<string | null | undefined>) => {
    for (const id of podIds) {
      if (!id) continue;
      void qc.invalidateQueries({ queryKey: ['pod', id] });
      void qc.invalidateQueries({ queryKey: ['pod-inner-pods', id] });
      void qc.invalidateQueries({ queryKey: ['pod-inner-pod-candidates', id] });
    }
    void qc.invalidateQueries({ queryKey: ['my-pods'] });
  };
}

/** Take a pod out of the main pod it is in. */
export function useTakePodOut() {
  const refresh = useNestingRefresh();
  const addToast = useToastStore((s) => s.addToast);
  return useMutation({
    networkMode: 'always',
    mutationFn: (pod: { id: string; name: string; parentPodId?: string | null }) =>
      api.delete(`/pods/${pod.id}/parent`).then((r) => r.data.data as { previousParentPodId: string | null }),
    onSuccess: (data, pod) => {
      refresh([pod.id, pod.parentPodId, data?.previousParentPodId]);
      addToast(NESTED_TOAST.takenOut(pod.name), 'success');
    },
    onError: (err) => addToast(refusalSentence(err), 'error'),
  });
}

/** Put one of the viewer's pods inside this main pod. */
export function usePutPodInside(main: { id: string; name: string }) {
  const refresh = useNestingRefresh();
  const addToast = useToastStore((s) => s.addToast);
  return useMutation({
    networkMode: 'always',
    mutationFn: (pod: { id: string; name: string }) => api.put(`/pods/${pod.id}/parent`, { parentPodId: main.id }),
    onSuccess: (_res, pod) => {
      refresh([main.id, pod.id]);
      addToast(NESTED_TOAST.putInside(pod.name, main.name), 'success');
    },
    onError: (err) => addToast(refusalSentence(err), 'error'),
  });
}

/** The main pod's director's choice that its pods are for its members. */
export function useSetInnerPodsMembersOnly(main: { id: string; name: string }) {
  const refresh = useNestingRefresh();
  const addToast = useToastStore((s) => s.addToast);
  return useMutation({
    networkMode: 'always',
    mutationFn: (on: boolean) => api.put(`/pods/${main.id}/inner-pods-setting`, { innerPodsMembersOnly: on }),
    onSuccess: (_res, on) => {
      refresh([main.id]);
      addToast(NESTED_TOAST.setting(on, main.name), 'success');
    },
    onError: (err) => addToast(refusalSentence(err), 'error'),
  });
}
