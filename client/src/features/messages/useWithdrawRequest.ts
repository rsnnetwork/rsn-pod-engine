// Withdrawing a meeting request the member sent (10 Nov 2026, Stefan: "if I have ALREADY asked them, why is that not
// shown?"). Every place that offers "I want to meet" now shows "Request sent" once it is pressed, with "Withdraw
// request" beside it, and they all withdraw through this one hook: Find people, For You's cards, the profile's bar,
// Matches, a search agent's people and the older profile page.
//
// Most of those lists know only the person, not the request's id, so the request is found first (GET
// /pokes/with/:userId, the newest request between the two still standing), then withdrawn. A page that already holds
// the id passes it. One mutation key per person: a double click, or two surfaces pressed at once, withdraws once.

import { useMutation, useMutationState, useQueryClient, type QueryClient } from '@tanstack/react-query';
import api from '@/lib/api';
import { useToastStore } from '@/stores/toastStore';
import { errorMessage, memberSentence } from '@/features/reason/errors';

type Outcome = 'withdrawn' | 'not_waiting';

/** One key per person, so every surface showing them knows a withdrawal is on its way. */
export function withdrawRequestKey(userId: string): readonly ['request-withdraw', string] {
  return ['request-withdraw', userId] as const;
}

interface RequestBetween { id: string; status: string; sentByMe: boolean }

async function withdrawRequestTo(userId: string, requestId: string | null): Promise<Outcome> {
  let id = requestId;
  if (!id) {
    const found = await api.get(`/pokes/with/${encodeURIComponent(userId)}`)
      .then((r) => r.data.data as RequestBetween | null);
    // Answered or withdrawn a moment ago (another tab, the other person): nothing is waiting to take back.
    if (!found || found.status !== 'pending' || !found.sentByMe) return 'not_waiting';
    id = found.id;
  }
  await api.post(`/pokes/${encodeURIComponent(id)}/withdraw`);
  return 'withdrawn';
}

/**
 * Every list that draws "Request sent" for this person, read again. The server's tags refresh the ones that declare
 * them; this also reaches the lists that poll or are a point-in-time search, and keeps the button busy until the
 * fresh state is in, so it never flickers back to "Request sent".
 */
function refreshAfterWithdraw(qc: QueryClient, userId: string) {
  return Promise.all([
    qc.invalidateQueries({ queryKey: ['user-find'] }),
    qc.invalidateQueries({ queryKey: ['reason'] }),
    qc.invalidateQueries({ queryKey: ['platformMatches'] }),
    qc.invalidateQueries({ queryKey: ['agent'] }),
    qc.invalidateQueries({ queryKey: ['agents'] }),
    qc.invalidateQueries({ queryKey: ['poke-with', userId] }),
  ]);
}

const FAILED = 'Could not withdraw that request. Try again.';

export function useWithdrawRequest(userId: string, requestId: string | null = null) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const mutation = useMutation({
    mutationKey: withdrawRequestKey(userId),
    // Offline, a press fails at once and says so, instead of waiting silently for the connection.
    networkMode: 'always',
    mutationFn: () => withdrawRequestTo(userId, requestId),
    onSuccess: (outcome) => {
      if (outcome === 'withdrawn') addToast('Request withdrawn. You can ask again any time.', 'success');
      else addToast('That request is no longer waiting for an answer.', 'info');
      return refreshAfterWithdraw(qc, userId);
    },
    onError: (err) => {
      // A 409 is where the request stands now (already withdrawn, or answered): said as information, then redrawn.
      const status = (err as { response?: { status?: number; data?: { error?: { message?: unknown } } } })?.response;
      if (status?.status === 409) {
        addToast(memberSentence(status.data?.error?.message) ?? 'That request is no longer waiting for an answer.', 'info');
      } else if (status?.status === 404) {
        addToast('That request is no longer there.', 'info');
      } else {
        addToast(errorMessage(err, FAILED), 'error');
      }
      return refreshAfterWithdraw(qc, userId);
    },
  });
  const inFlight = useMutationState({ filters: { mutationKey: withdrawRequestKey(userId), status: 'pending' } });
  // The mutation cache holds a withdrawal from the instant it starts; a disabled button only follows a render later.
  const withdraw = () => {
    if (qc.isMutating({ mutationKey: withdrawRequestKey(userId) }) > 0) return;
    mutation.mutate();
  };
  return { withdraw, busy: inFlight.length > 0 };
}
