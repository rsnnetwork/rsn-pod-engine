// Answering a meeting request, from any surface (26 Oct 2026): the bell, the Messages list card and the focused card.
// One mutation key per request (requestAnswerKey), so every surface showing the request knows when any of them is
// answering it and offers no second answer meanwhile. The surface that answered keeps its buttons busy until every
// list that shows the request has redrawn from the server; the others redraw through the entity tags the server emits.

import { useMutation, useMutationState, useQueryClient, type QueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';
import { errorMessage } from '@/features/reason/errors';
import { alreadyAnswered, requestAnswerKey, type Answer } from './request-answer';

/** What accept and decline answer with. Accept carries the conversation, so a repeated accept lands in it too. */
export interface AnswerResult { conversationId?: string | null }

function refreshAfterAnswer(qc: QueryClient, requestId: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ['notifications'] }),
    qc.invalidateQueries({ queryKey: ['pokes-received'] }),
    qc.invalidateQueries({ queryKey: ['poke-state', requestId] }),
    qc.invalidateQueries({ queryKey: ['dm-conversations'] }),
  ]);
}

/**
 * What the surface that answered does next. These run from the mutation's own options, not from mutate()'s: a card
 * whose request is answered leaves the list as the list refreshes, and React Query drops mutate()'s callbacks for a
 * component that is gone, so "accept, then land in the conversation" was lost on the Messages list card.
 */
export interface AnswerFollowUp {
  onAccepted?: (result: AnswerResult) => void;
  onDeclined?: () => void;
}

export function useRequestAnswer(requestId: string, followUp: AnswerFollowUp = {}) {
  const qc = useQueryClient();
  const addToast = useToastStore(s => s.addToast);
  const mutation = useMutation({
    mutationKey: requestAnswerKey(requestId),
    mutationFn: (answer: Answer) => api.post(`/pokes/${requestId}/${answer}`).then(r => (r.data.data ?? {}) as AnswerResult),
    onSuccess: (result, answer) => {
      if (answer === 'accept') followUp.onAccepted?.(result);
      else followUp.onDeclined?.();
      return refreshAfterAnswer(qc, requestId);
    },
    onError: (err) => {
      // Answered the other way already (another tab, another device): say which, and redraw from the server.
      const answered = alreadyAnswered(err);
      if (answered) addToast(answered.message, 'info');
      else addToast(errorMessage(err, 'Could not answer that request. Try again.'), 'error');
      return refreshAfterAnswer(qc, requestId);
    },
  });
  const inFlight = useMutationState({
    filters: { mutationKey: requestAnswerKey(requestId), status: 'pending' },
    select: (m) => m.state.variables as Answer | undefined,
  });
  return {
    answer: mutation.mutate,
    /** Some surface is answering this request right now. */
    busy: inFlight.length > 0,
    /** Which answer is on its way, for the busy button's words. */
    answering: inFlight[0] ?? null,
  };
}
