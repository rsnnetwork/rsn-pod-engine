// ─── Link an entity to a circle (T15, 1 Nov 2026; 30 Oct review 7.3) ─────────────────────────────────────────────
// For the people who run the circle. A searchable sheet on the Entities list's own search (GET /entities?q=, the same
// cache entry per term): the most recently active entities until two letters are typed, then the names that match,
// the viewer's own first. Entities already linked are left out. Link answers with a toast and the circle's
// Organisations update here at once, and on every other screen through circle:<id>.
import { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import Sheet from '@/features/reason/ui/Sheet';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Spinner';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import api from '@/lib/api';
import { E } from '@/realtime/entities';
import { useAuthStore } from '@/stores/authStore';
import { useToastStore } from '@/stores/toastStore';
import EntityMark from '@/features/reason/entities/EntityMark';
import { entityKeys, fetchEntities } from '@/features/reason/entities/entity-api';
import { entityMeta, searchTerm } from '@/features/reason/entities/entity-text';
import { LINK_ENTITY, LINK_SEARCH_HINT, linkedToast } from './circle-logic';
import { circleErrorSentence, refreshCircle } from './useCircleActions';

interface Props { circleId: string; circleName: string; linked: string[]; onClose: () => void }

export default function LinkEntitySheet({ circleId, circleName, linked, onClose }: Props) {
  const me = useAuthStore((s) => s.user?.id as string | undefined);
  const qc = useQueryClient();
  const addToast = useToastStore((s) => s.addToast);
  const [typed, setTyped] = useState('');
  const term = searchTerm(useDebouncedValue(typed, 300));
  const found = useQuery({
    queryKey: entityKeys.list(term),
    queryFn: () => fetchEntities(term),
    enabled: !!me,
    placeholderData: keepPreviousData,
    meta: { entities: me ? [E.userEntities(me)] : [] },
  });
  const link = useMutation({
    networkMode: 'always',
    mutationFn: ({ entityId }: { entityId: string; name: string }) => api.post(`/circles/${circleId}/entities`, { entityId }),
    onSuccess: async (_res, { name }) => {
      await Promise.all([refreshCircle(qc, circleId), qc.invalidateQueries({ queryKey: entityKeys.all })]);
      addToast(linkedToast(name, circleName), 'success');
      onClose();
    },
    onError: (err) => addToast(circleErrorSentence(err, 'That entity could not be linked. Try again.'), 'error'),
  });

  // The server does not narrow your own entities by the search, so they are narrowed here (AlreadyOnReason's rule).
  const needle = term.toLowerCase();
  const mine = (found.data?.mine ?? []).filter((e) => !needle || e.name.toLowerCase().includes(needle));
  const items = [...mine, ...(found.data?.others ?? [])].filter((e) => !linked.includes(e.id));

  return (
    <Sheet open onClose={onClose} title={LINK_ENTITY}>
      <label className="relative mt-3 block">
        <span className="sr-only">Search entities by name</span>
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-reason-muted" aria-hidden="true" />
        <input
          type="search" value={typed} onChange={(e) => setTyped(e.target.value)} maxLength={200} enterKeyHint="search"
          placeholder="Search entities by name" data-testid="link-entity-search"
          className="min-h-[44px] w-full rounded-[11px] border border-reason-line bg-white pl-9 pr-3 text-[16px] text-reason-ink placeholder:text-reason-muted md:text-[14px]"
        />
      </label>
      {typed.trim().length === 1 && <p className="mt-1.5 text-[12px] text-reason-muted">{LINK_SEARCH_HINT}</p>}
      <div className="mt-2" data-testid="link-entity-results">
        {found.isPending ? (
          <div className="grid gap-2" aria-busy="true">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-[56px]" />)}</div>
        ) : found.isError && items.length === 0 ? (
          <div role="alert" className="rounded-2xl border border-reason-line p-3.5">
            <p className="text-[14px] font-bold">We could not search entities just now.</p>
            <Button type="button" onClick={() => void found.refetch()} className="mt-3 min-h-[44px]">Try again</Button>
          </div>
        ) : items.length === 0 ? (
          <p className="rounded-2xl bg-reason-warm p-3.5 text-[13px] text-reason-muted [overflow-wrap:anywhere]">
            {term ? `No entity on REASON matches “${term}” that is not linked here already.` : 'Every entity listed here is linked already. Search for another by name.'}
          </p>
        ) : (
          <ul className="divide-y divide-reason-line">
            {items.map((e) => (
              <li key={e.id} data-link-entity={e.id} className="flex min-h-[56px] items-center gap-3 py-2">
                <EntityMark name={e.name} size="row" logoUrl={e.logoUrl} />
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-bold text-reason-ink [overflow-wrap:anywhere]">{e.name}</p>
                  <p className="truncate text-[12px] text-reason-muted">{entityMeta(e)}</p>
                </div>
                <Button
                  type="button" size="sm" variant="outline" className="min-h-[44px] shrink-0"
                  disabled={link.isPending}
                  isLoading={link.isPending && link.variables?.entityId === e.id}
                  onClick={() => link.mutate({ entityId: e.id, name: e.name })}
                >Link</Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Sheet>
  );
}
