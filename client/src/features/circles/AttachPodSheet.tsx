// ─── Attach a pod to a circle (T14, 1 Nov 2026; 30 Oct review 7.6) ───────────────────────────────────────────────
// A searchable sheet, not a bare <select>: the pods the viewer directs or hosts (a platform admin: every pod), none
// archived or attached already, 50 at a time from GET /circles/:id/attachable-pods. "Create a new pod" sits at its top,
// so a manager never has to leave the circle to make the pod first.
import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Search } from 'lucide-react';
import type { CircleAttachablePodPage } from '@rsn/shared';
import Sheet from '@/features/reason/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Spinner';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import { ATTACH_EMPTY } from './circle-logic';
import { circleErrorSentence, refreshCircle } from './useCircleActions';

interface Props { circleId: string; circleName: string; onClose: () => void; onCreate: () => void }

export default function AttachPodSheet({ circleId, circleName, onClose, onCreate }: Props) {
  const me = useAuthStore((s) => s.user?.id as string | undefined);
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), 300);
  const pods = useInfiniteQuery({
    queryKey: ['circle-attachable', circleId, q],
    queryFn: ({ pageParam, signal }) => api.get(`/circles/${circleId}/attachable-pods`, { params: { q: q || undefined, page: pageParam, pageSize: 50 }, signal })
      .then((r) => r.data.data as CircleAttachablePodPage),
    initialPageParam: 1,
    getNextPageParam: (last) => last.nextPage ?? undefined,
    placeholderData: (previous) => previous,
    meta: { entities: [E.circle(circleId), ...(me ? [E.userPods(me)] : [])] },
  });
  const attach = useMutation({
    networkMode: 'always',
    mutationFn: ({ podId }: { podId: string; name: string }) => api.post(`/circles/${circleId}/pods`, { podId }),
    onSuccess: async (_res, { name }) => {
      await Promise.all([refreshCircle(qc, circleId), qc.invalidateQueries({ queryKey: ['circle-attachable', circleId] })]);
      addToast(`${name} is added to ${circleName}.`, 'success');
    },
    onError: (err) => addToast(circleErrorSentence(err, 'That pod could not be attached. Try again.'), 'error'),
  });
  const items = pods.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <Sheet open onClose={onClose} title="Attach a pod">
      <button
        type="button"
        onClick={onCreate}
        data-testid="circle-new-pod-from-attach"
        className="mt-3 inline-flex min-h-[44px] w-full items-center justify-center gap-2 rounded-[11px] border border-reason-red px-4 text-[14px] font-bold text-reason-red hover:bg-reason-pink"
      >
        <Plus className="h-4 w-4" aria-hidden="true" /> Create a new pod
      </button>
      <label className="relative mt-3 block">
        <span className="sr-only">Search your pods</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-reason-muted" aria-hidden="true" />
        <input
          type="search" value={search} onChange={(e) => setSearch(e.target.value)} maxLength={100} enterKeyHint="search"
          placeholder="Search your pods by name"
          className="min-h-[44px] w-full rounded-[11px] border border-reason-line bg-white pl-9 pr-3 text-[16px] text-reason-ink placeholder:text-reason-muted md:text-[14px]"
        />
      </label>
      <div className="mt-2" data-testid="circle-attachable">
        {pods.isPending ? (
          <div className="grid gap-2" aria-busy="true">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[56px]" />)}</div>
        ) : pods.isError && items.length === 0 ? (
          <div role="alert" className="rounded-2xl border border-reason-line p-3.5">
            <p className="text-[14px] font-bold">We could not load your pods just now.</p>
            <Button type="button" onClick={() => void pods.refetch()} className="mt-3 min-h-[44px]">Try again</Button>
          </div>
        ) : items.length === 0 ? (
          <p className="rounded-2xl bg-reason-warm p-3.5 text-[13px] text-reason-muted [overflow-wrap:anywhere]">
            {q ? `None of your pods matches “${q}”.` : ATTACH_EMPTY}
          </p>
        ) : (
          <ul className="divide-y divide-reason-line">
            {items.map((p) => (
              <li key={p.podId} className="flex min-h-[56px] items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[14px] font-bold text-reason-ink">{p.name}</p>
                  {p.description && <p className="truncate text-[12px] text-reason-muted">{p.description}</p>}
                </div>
                <Button
                  type="button" size="sm" variant="outline" className="min-h-[44px] shrink-0"
                  disabled={attach.isPending}
                  isLoading={attach.isPending && attach.variables?.podId === p.podId}
                  onClick={() => attach.mutate({ podId: p.podId, name: p.name })}
                  data-testid={`circle-attach-${p.podId}`}
                >Attach</Button>
              </li>
            ))}
          </ul>
        )}
        {pods.hasNextPage && (
          <div className="mt-3 flex justify-center">
            <Button type="button" variant="outline" className="min-h-[44px]" isLoading={pods.isFetchingNextPage} onClick={() => void pods.fetchNextPage()}>Show more</Button>
          </div>
        )}
      </div>
    </Sheet>
  );
}
