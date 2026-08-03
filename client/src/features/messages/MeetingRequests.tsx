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

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Check, X } from 'lucide-react';
import Avatar from '@/components/ui/Avatar';
import { useToastStore } from '@/stores/toastStore';
import { E } from '@/realtime/entities';
import api from '@/lib/api';

export interface PendingRequest {
  id: string;
  senderId: string;
  message: string | null;
  createdAt: string;
  senderDisplayName: string | null;
  senderAvatarUrl: string | null;
}

export default function MeetingRequests({ myUserId }: { myUserId: string }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const addToast = useToastStore(s => s.addToast);

  const { data: requests } = useQuery({
    queryKey: ['pokes-received'],
    queryFn: () => api.get('/pokes/received').then(r => r.data.data as PendingRequest[]),
    refetchOnWindowFocus: true,
    meta: { entities: [E.userInvites(myUserId)] },
  });

  // A resolved-elsewhere request (other tab, stale page) must not strand the
  // user on a broken card — drop it from the list and say why.
  function settle(err: unknown, fallback: string) {
    const message = (err as any)?.response?.data?.error?.message || fallback;
    addToast(message, 'info');
    qc.invalidateQueries({ queryKey: ['pokes-received'] });
  }

  const acceptMutation = useMutation({
    mutationFn: (id: string) =>
      api.post(`/pokes/${id}/accept`).then(r => r.data.data as { conversationId: string }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['pokes-received'] });
      qc.invalidateQueries({ queryKey: ['dm-conversations'] });
      addToast('Connected — say hello', 'success');
      if (data?.conversationId) navigate(`/messages/${data.conversationId}`);
    },
    onError: (err) => settle(err, 'That request was already handled'),
  });

  const declineMutation = useMutation({
    mutationFn: (id: string) => api.post(`/pokes/${id}/decline`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pokes-received'] });
    },
    onError: (err) => settle(err, 'That request was already handled'),
  });

  const pending = acceptMutation.isPending || declineMutation.isPending;
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
          <div
            key={r.id}
            data-testid="meeting-request"
            data-sender-id={r.senderId}
            className="rounded-xl border border-rsn-red/20 bg-white p-3"
          >
            <div className="flex items-start gap-3">
              <Avatar src={r.senderAvatarUrl || undefined} name={r.senderDisplayName || 'Member'} size="md" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-[#1a1a2e]">
                  {r.senderDisplayName || 'A member'}
                </p>
                <p className="mt-0.5 break-words text-xs text-gray-600">
                  {r.message || 'They would like to meet you.'}
                </p>
              </div>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => acceptMutation.mutate(r.id)}
                disabled={pending}
                className="flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg bg-rsn-red px-3 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                <Check className="h-4 w-4" /> Accept
              </button>
              <button
                type="button"
                onClick={() => declineMutation.mutate(r.id)}
                disabled={pending}
                className="flex min-h-[44px] flex-1 items-center justify-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50 disabled:opacity-50"
              >
                <X className="h-4 w-4" /> Decline
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
