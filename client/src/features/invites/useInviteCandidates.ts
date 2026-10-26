// ─── The invite sheet's server calls (26 Oct 2026, C9, POD-02 and the invites half of POD-04) ───
//
// GET /invites/candidates lists the organiser's connections, or the members of an event's pod, with where each person
// stands against the pod or event, a page at a time (nextBefore). POST /invites/batch invites up to 50 of them by id
// in one call. POST /invites stays for one typed address and for a shareable link. Every query follows the tags the
// server sends when its answer changes; every write also refetches, on the sender's own screen, what the server's
// fan-out names, because the sender may be in no list the fan-out reaches (an admin who is not in the pod).
import { useInfiniteQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { InviteBatchResponse, InviteCandidatePage, InviteCandidateSource } from '@rsn/shared';
import api from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import { batchBody, candidateEntities, candidateParams, emailInviteBody, linkBody, targetTags, type InviteTarget } from './invite-picker';

/** Everything the sheet has read for one pod or event, whatever the list and the search. */
export const targetKey = (target: InviteTarget) => ['invite-candidates', target.type, target.type === 'pod' ? target.podId : target.sessionId] as const;

/** Every query that declares one of these tags is read again, as the app does when the server sends them. */
export function invalidateTags(qc: QueryClient, tags: readonly string[]): void {
  const wanted = new Set(tags);
  void qc.invalidateQueries({
    predicate: (query) => {
      const declared = (query.meta as { entities?: unknown } | undefined)?.entities;
      return Array.isArray(declared) && declared.some((tag) => typeof tag === 'string' && wanted.has(tag));
    },
  });
}

/** How long a list read stays fresh: the server allows 60 candidate reads a minute per member, shared with People. */
const CANDIDATES_FRESH_MS = 60_000;

/**
 * One list of the sheet: your connections (`connections`) or the event's pod (`pod`), searched by `q` (blank to
 * browse). While a new search is on its way the last answer for the same list stays on screen; another list starts
 * from nothing, so the pod's members are never shown under "Your connections". A list is read again only when a tag it
 * follows arrives or a minute has passed, never on focus, and every loaded page is forgotten when the sheet closes, so
 * each opening reads one page (a refetch re-reads every page loaded so far).
 */
export function useInviteCandidates(target: InviteTarget, source: InviteCandidateSource, q: string, enabled: boolean) {
  const me = useAuthStore((s) => s.user?.id as string | undefined);
  return useInfiniteQuery({
    queryKey: [...targetKey(target), source, q.trim()],
    queryFn: ({ pageParam }) =>
      api.get('/invites/candidates', { params: candidateParams(target, source, q, pageParam) }).then((r) => r.data.data as InviteCandidatePage),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    enabled,
    staleTime: CANDIDATES_FRESH_MS,
    refetchOnWindowFocus: false,
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[3] === source ? previous : undefined),
    meta: { entities: candidateEntities(target, source, me) },
  });
}

/** What a page's screen does with a write's answer; on the mutation itself, so it still runs if the sheet has closed. */
interface Handlers<TData, TVariables> {
  onSuccess: (data: TData, variables: TVariables) => void;
  onError: (error: unknown, variables: TVariables) => void;
  onSettled?: () => void;
}

export interface BatchRequest { ids: string[]; allPodMembers?: boolean }

/** Up to 50 people by id, or everyone in an event's pod, in one call. */
export function useSendInvites(target: InviteTarget, handlers: Handlers<InviteBatchResponse, BatchRequest>) {
  const qc = useQueryClient();
  return useMutation<InviteBatchResponse, unknown, BatchRequest>({
    // Tried at once even while the browser says it is offline: held back, the press would look stuck, then go by itself.
    networkMode: 'always',
    mutationFn: ({ ids, allPodMembers }) =>
      api.post('/invites/batch', batchBody(target, ids, allPodMembers)).then((r) => r.data.data as InviteBatchResponse),
    onSuccess: (data, variables) => {
      invalidateTags(qc, targetTags(target));
      handlers.onSuccess(data, variables);
    },
    onError: (error, variables) => handlers.onError(error, variables),
    onSettled: () => handlers.onSettled?.(),
  });
}

/** One invite to a typed address (someone who is not among your connections, or not on REASON yet). */
export function useInviteByEmail(target: InviteTarget, handlers: Handlers<string, string>) {
  const qc = useQueryClient();
  return useMutation<unknown, unknown, string>({
    networkMode: 'always',
    mutationFn: (email) => api.post('/invites', emailInviteBody(target, email)),
    onSuccess: (_answer, email) => {
      invalidateTags(qc, targetTags(target));
      handlers.onSuccess(email.trim(), email);
    },
    onError: (error, email) => handlers.onError(error, email),
  });
}

/** A shareable link for up to `cap` people, a week long. Its answer is the invite code the link is made from. */
export function useShareLink(target: InviteTarget, cap: number, handlers: Handlers<string, void>) {
  const qc = useQueryClient();
  return useMutation<string, unknown, void>({
    networkMode: 'always',
    mutationFn: () => api.post('/invites', linkBody(target, cap)).then((r) => (r.data.data as { code: string }).code),
    onSuccess: (code) => {
      invalidateTags(qc, targetTags(target));
      handlers.onSuccess(code);
    },
    onError: (error) => handlers.onError(error),
  });
}
