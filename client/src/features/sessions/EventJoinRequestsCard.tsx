// client/src/features/sessions/EventJoinRequestsCard.tsx
// T11 (1 Nov 2026; L17) — the organisers' Requests (N) card on an event that asks the host to approve each place:
// one row per person who asked, with Approve and Decline (44px). It follows the server live: every request write
// tells the organisers' open pages (session:<id>, sent with session:<id>:join-requests).
// Final fix wave X1 (2 Nov 2026): a decline is final (the person cannot ask again), so Decline asks first, in the page.
import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Card from '@/components/ui/Card';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { useToastStore } from '@/stores/toastStore';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { useConfirm } from '@/hooks/useConfirm';

interface RequestRow {
  id: string;
  userId: string;
  displayName: string;
  firstName: string;
  avatarUrl: string | null;
  jobTitle: string | null;
  company: string | null;
  message: string | null;
}

export const REQUESTS_COPY = {
  title: 'Requests',
  empty: 'No one is waiting for a place.',
  error: 'The requests could not be read just now.',
  retry: 'Try again',
  approve: 'Approve',
  decline: 'Decline',
  approved: (name: string) => `${name} has a place now.`,
  declined: (name: string) => `${name} was declined.`,
  declineTitle: (name: string) => `Decline ${name}?`,
  declineBody: 'They will not get a place at this event, and they cannot ask again.',
  fallback: 'That did not go through. Please try again.',
};

function serverSentence(err: unknown): string {
  const message = (err as { response?: { data?: { error?: { message?: string } } } })?.response?.data?.error?.message;
  return message || REQUESTS_COPY.fallback;
}

interface Props {
  sessionId: string;
  /** ?requests=1: the bell's link scrolls the card into view. */
  focus: boolean;
}

export default function EventJoinRequestsCard({ sessionId, focus }: Props) {
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const cardRef = useRef<HTMLDivElement>(null);
  const { ask, confirmDialog } = useConfirm();

  const { data, isLoading, isError, refetch } = useQuery<RequestRow[]>({
    queryKey: ['session-join-requests', sessionId],
    queryFn: () => api.get(`/sessions/${sessionId}/requests`, { params: { status: 'pending' } }).then((r) => r.data.data ?? []),
    // The server sends session:<id> with session:<id>:join-requests on every request write; the card follows its own
    // tag too, so it keeps working if the broad one is ever narrowed (X3, 2 Nov 2026).
    meta: { entities: [E.session(sessionId), E.sessionJoinRequests(sessionId)] },
  });

  useEffect(() => {
    if (focus && cardRef.current) cardRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focus, isLoading]);

  const answer = useMutation({
    mutationFn: ({ row, verb }: { row: RequestRow; verb: 'approve' | 'decline' }) =>
      api.post(`/sessions/${sessionId}/requests/${row.userId}/${verb}`),
    onSuccess: (_res, { row, verb }) => {
      const name = row.firstName || row.displayName;
      addToast(verb === 'approve' ? REQUESTS_COPY.approved(name) : REQUESTS_COPY.declined(name), 'success');
      qc.invalidateQueries({ queryKey: ['session-join-requests', sessionId] });
      qc.invalidateQueries({ queryKey: ['session-participants', sessionId] });
    },
    onError: (err) => addToast(serverSentence(err), 'error'),
  });

  const decline = async (row: RequestRow) => {
    const name = row.firstName || row.displayName;
    if (!(await ask({ title: REQUESTS_COPY.declineTitle(name), body: REQUESTS_COPY.declineBody, confirmLabel: REQUESTS_COPY.decline, tone: 'danger' }))) return;
    answer.mutate({ row, verb: 'decline' });
  };

  const rows = data ?? [];
  return (
    <div ref={cardRef} id="event-requests" className="scroll-mt-4" data-testid="event-requests-card">
      <Card className="animate-fade-in-up">
        <h2 className="text-lg font-semibold text-[#1a1a2e] mb-3">
          {REQUESTS_COPY.title} {isLoading || isError ? '' : `(${rows.length})`}
        </h2>
        {isLoading && <div className="h-12 rounded-xl bg-gray-100 animate-pulse" aria-label="Loading requests" />}
        {isError && (
          <div className="flex flex-wrap items-center gap-3 text-sm text-gray-600">
            <span>{REQUESTS_COPY.error}</span>
            <Button variant="ghost" className="min-h-[44px]" onClick={() => refetch()}>{REQUESTS_COPY.retry}</Button>
          </div>
        )}
        {!isLoading && !isError && rows.length === 0 && <p className="text-sm text-gray-500">{REQUESTS_COPY.empty}</p>}
        <ul className="space-y-3">
          {rows.map((row) => {
            const busy = answer.isPending && answer.variables?.row.userId === row.userId;
            const subtitle = [row.jobTitle, row.company].filter(Boolean).join(' · ');
            return (
              <li key={row.id} data-testid="event-request-row" className="flex flex-wrap items-center gap-3">
                <Avatar src={row.avatarUrl ?? undefined} name={row.displayName} size="md" />
                <div className="min-w-0 flex-1 basis-40">
                  <p className="font-medium text-gray-900 break-words">{row.displayName}</p>
                  {subtitle && <p className="text-xs text-gray-500 break-words">{subtitle}</p>}
                  {row.message && <p className="text-sm text-gray-700 mt-1 break-words">{row.message}</p>}
                </div>
                <div className="flex gap-2">
                  <Button
                    data-testid="event-request-approve"
                    className="min-h-[44px]"
                    disabled={answer.isPending}
                    isLoading={busy && answer.variables?.verb === 'approve'}
                    onClick={() => answer.mutate({ row, verb: 'approve' })}
                  >
                    {REQUESTS_COPY.approve}
                  </Button>
                  <Button
                    data-testid="event-request-decline"
                    variant="ghost"
                    className="min-h-[44px]"
                    disabled={answer.isPending}
                    isLoading={busy && answer.variables?.verb === 'decline'}
                    onClick={() => void decline(row)}
                  >
                    {REQUESTS_COPY.decline}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
      {confirmDialog}
    </div>
  );
}
