// ─── The asks waiting to join a closed circle, for the people who run it (T14, 1 Nov 2026; 30 Oct review 7.5) ──────
// Opened from "Requests (n)" or by a bell's link (?requests=1). Each row: the person (name, then their work) and, on
// a line of their own at 360, Approve and Decline as 44px buttons. It follows circle:<id>:requests, so an ask made
// while it is open appears at once, and an answer given on another screen leaves it.
import { useQuery } from '@tanstack/react-query';
import type { CircleJoinRequest } from '@rsn/shared';
import Sheet from '@/features/reason/ui/Sheet';
import ReasonSheep from '@/features/reason/brand/ReasonSheep';
import Avatar from '@/components/ui/Avatar';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Spinner';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { NO_REQUESTS } from './circle-logic';
import { useAnswerRequest } from './useCircleActions';

export default function CircleRequestsSheet({ circleId, onClose }: { circleId: string; onClose: () => void }) {
  const requests = useQuery<CircleJoinRequest[]>({
    queryKey: ['circle-requests', circleId],
    queryFn: () => api.get(`/circles/${circleId}/requests`).then((r) => r.data.data ?? []),
    meta: { entities: [E.circleRequests(circleId), E.circle(circleId)] },
  });
  const answer = useAnswerRequest(circleId);

  return (
    <Sheet open onClose={onClose} title="Requests to join">
      <div className="mt-3" data-testid="circle-requests">
        {requests.isPending ? (
          <div className="grid gap-2" aria-busy="true">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-[88px]" />)}
          </div>
        ) : requests.isError ? (
          <div role="alert" className="rounded-2xl border border-reason-line p-3.5">
            <p className="text-[14px] font-bold">We could not load the requests just now.</p>
            <Button type="button" onClick={() => void requests.refetch()} className="mt-3 min-h-[44px]">Try again</Button>
          </div>
        ) : requests.data.length === 0 ? (
          <div className="flex items-center gap-3 rounded-2xl bg-reason-warm p-3.5">
            <ReasonSheep pose="hopeful" className="h-[52px] w-[52px] shrink-0" />
            <p className="text-[14px] font-bold text-reason-ink">{NO_REQUESTS}</p>
          </div>
        ) : (
          <ul className="divide-y divide-reason-line">
            {requests.data.map((r) => {
              const name = r.displayName || 'A member';
              const work = [r.jobTitle, r.company].filter(Boolean).join(' · ');
              const mine = answer.isPending && answer.variables?.userId === r.userId;
              return (
                <li key={r.userId} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center" data-testid={`circle-request-${r.userId}`}>
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <Avatar src={r.avatarUrl || undefined} name={name} size="md" className="shrink-0" />
                    <div className="min-w-0">
                      <p className="truncate text-[14px] font-bold text-reason-ink">{name}</p>
                      {work && <p className="truncate text-[12px] text-reason-muted">{work}</p>}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:flex">
                    <Button
                      type="button" size="sm" className="min-h-[44px]" disabled={answer.isPending}
                      isLoading={mine && answer.variables?.verb === 'approve'}
                      onClick={() => answer.mutate({ userId: r.userId, name, verb: 'approve' })}
                    >Approve</Button>
                    <Button
                      type="button" size="sm" variant="outline" className="min-h-[44px]" disabled={answer.isPending}
                      isLoading={mine && answer.variables?.verb === 'decline'}
                      onClick={() => answer.mutate({ userId: r.userId, name, verb: 'decline' })}
                    >Decline</Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Sheet>
  );
}
