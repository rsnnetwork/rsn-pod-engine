// Pending meeting requests — the accept surface for the poke loop.
//
// 30 Jul 2026 evaluation, P1: the accept/decline API had existed since May but
// no client surface ever called it. The 'poke' notification links to /messages,
// and /messages renders dm_conversations — which acceptPoke itself creates — so
// the recipient landed on a guaranteed-empty page with no way to accept. This
// section is that missing surface, deliberately placed where the existing
// notification link already points so the server contract needs no change.
//
// Realtime: sendPoke fans out E.userInvites(recipient), so keying this query to
// that entity makes a new request appear without a refresh.

import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { useNavigate } from 'react-router-dom';
import { Spinner } from '@/components/ui/Spinner';
import { E } from '@/realtime/entities';
import api from '@/lib/api';
import MeetingRequestCard, { type PendingRequest } from './MeetingRequestCard';

/** Where one request stands, from GET /pokes/:id (either person in it may ask). */
interface PokeState {
  /** 'cancelled' is a request its sender withdrew (10 Nov 2026). */
  status: 'pending' | 'accepted' | 'declined' | 'cancelled';
  conversationId: string | null;
  otherUserId: string;
  /** True when this member sent the request rather than received it. */
  sentByMe: boolean;
}

/** What the card says when the request is not on the member's list, and whether it offers Try again. */
interface Notice {
  text: string;
  retry?: boolean;
}

/**
 * What to say about a request that is not in the member's list of pending ones,
 * or null to keep waiting. "Already answered" is only true of a request that was
 * accepted or declined. One that is still pending is simply not in the list YET:
 * the list is still on its way, or a refresh is. The page used to call it answered
 * whenever GET /pokes/:id came back before GET /pokes/received (5 Oct 2026).
 * `failed` is a question that got no answer at all (the network dropping, a 429, a
 * 5xx): that says nothing about the request, so it is never "not available".
 */
function noticeFor(state: PokeState | null | undefined, failed: boolean): Notice | null {
  if (state?.status === 'declined') {
    // Either person may open the link, and only one of them did the turning down.
    return { text: state.sentByMe ? 'They turned your meeting request down.' : 'You turned this meeting request down.' };
  }
  if (state?.status === 'accepted') return { text: 'This meeting request has already been answered.' };
  if (state?.status === 'cancelled') {
    return { text: state.sentByMe ? 'You withdrew this meeting request.' : 'They withdrew this meeting request.' };
  }
  if (failed) return { text: 'We could not load this meeting request.', retry: true };
  if (state?.status === 'pending') {
    // A member who SENT it will never find it among the ones they received.
    return state.sentByMe ? { text: 'They have not answered your meeting request yet.' } : null;
  }
  return { text: 'This meeting request is not available.' };
}

/**
 * The big "who wants to meet you" panel shown in the right pane when the bell
 * link lands on /messages?poke=<id> (7 Sep 2026, Ali): the recipient sees the
 * requester's profile card — photo, name, role, company, why — with Accept /
 * Decline right there, and can open the full profile before deciding.
 */
export function FocusedMeetingRequest({ pokeId, myUserId }: { pokeId: string; myUserId: string }) {
  // isPending, not isLoading, below: it stays true until there is an answer, including while the
  // fetch is paused because the phone is offline. isLoading is false then, and the card would
  // say the request is not available when nobody has been asked yet.
  const { data: requests, isPending: listPending, isError: listFailed, isFetching: listFetching, refetch: refetchList } = useQuery({
    queryKey: ['pokes-received'],
    queryFn: () => api.get('/pokes/received').then(r => r.data.data as PendingRequest[]),
    refetchInterval: 20_000,
    meta: { entities: [E.userInvites(myUserId)] },
  });
  const req = (requests || []).find(r => r.id === pokeId);

  // /pokes/received only carries PENDING requests, so one that has been
  // answered — in another tab, or reached again from an old email — used to
  // land on a line telling the member to go and find the conversation for
  // themselves. Ask where this one stands and take them there (22 Sep 2026).
  const {
    data: state, isPending: statePending, isError: stateFailed, isFetching: stateFetching, refetch: refetchState,
  } = useQuery({
    queryKey: ['poke-state', pokeId],
    queryFn: () => api.get(`/pokes/${pokeId}`).then(r => r.data.data as PokeState).catch((err: unknown) => {
      // A 404 (not theirs, or not there) and a 403 are answers. Anything else, such as the
      // network dropping, a 429 or a 5xx, is a question that got no answer: it throws, so React
      // Query asks again, and if it keeps failing the card says so and offers Try again.
      if (isAxiosError(err) && (err.response?.status === 403 || err.response?.status === 404)) return null;
      throw err;
    }),
    enabled: !req,
    meta: { entities: [E.userInvites(myUserId)] },
  });
  const navigate = useNavigate();
  useEffect(() => {
    if (!req && state?.status === 'accepted' && state.conversationId) {
      navigate(`/messages/${state.conversationId}`, { replace: true });
    }
  }, [req, state, navigate]);

  if (!req) {
    const redirecting = state?.status === 'accepted' && !!state.conversationId;
    const notice = listPending || statePending || redirecting ? null : noticeFor(state, listFailed || stateFailed);
    if (notice === null) {
      return <div className="flex-1 flex items-center justify-center"><Spinner /></div>;
    }
    const retrying = (listFailed && listFetching) || (stateFailed && stateFetching);
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-gray-500">{notice.text}</p>
        <div className="flex flex-wrap items-center justify-center gap-2">
          {notice.retry && (
            <button
              type="button"
              onClick={() => {
                if (listFailed) void refetchList();
                if (stateFailed) void refetchState();
              }}
              disabled={retrying}
              className="min-h-[44px] rounded-lg bg-rsn-red px-4 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {retrying ? 'Trying again…' : 'Try again'}
            </button>
          )}
          <button
            type="button"
            onClick={() => navigate('/messages', { replace: true })}
            className="min-h-[44px] rounded-lg border border-gray-300 bg-white px-4 text-sm font-medium text-gray-700 hover:bg-gray-50"
          >
            Back to messages
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex items-center justify-center p-4 sm:p-6">
      <MeetingRequestCard request={req} variant="focused" onDeclined={() => navigate('/messages')} />
    </div>
  );
}

export default function MeetingRequests({ myUserId, focusPokeId }: { myUserId: string; focusPokeId?: string | null }) {
  const focusRef = useRef<HTMLDivElement>(null);

  const { data: requests } = useQuery({
    queryKey: ['pokes-received'],
    queryFn: () => api.get('/pokes/received').then(r => r.data.data as PendingRequest[]),
    refetchOnWindowFocus: true,
    // The entity fanout is the fast path, but it is a one-shot socket event:
    // a request that lands while the socket is reconnecting (backgrounded
    // phone, network blip — both routine here) would otherwise stay invisible
    // until a manual refresh. Poll as the guaranteed path; one indexed query
    // per open Messages page is cheap next to a silently missed request.
    refetchInterval: 20_000,
    refetchOnReconnect: true,
    meta: { entities: [E.userInvites(myUserId)] },
  });

  // Scroll the bell-linked request into view once it renders.
  useEffect(() => {
    if (focusPokeId && focusRef.current) {
      focusRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [focusPokeId, requests]);

  if (!requests || requests.length === 0) return null;

  return (
    <div className="border-b border-gray-200 bg-rsn-red-light/40">
      <div className="px-4 pt-3 pb-1">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-rsn-red">
          Meeting requests ({requests.length})
        </h3>
      </div>
      <div className="flex flex-col gap-2 px-3 pb-3 pt-2">
        {requests.map(r => (
          <div key={r.id} ref={focusPokeId === r.id ? focusRef : undefined}>
            <MeetingRequestCard request={r} variant="list" highlighted={focusPokeId === r.id} />
          </div>
        ))}
      </div>
    </div>
  );
}
