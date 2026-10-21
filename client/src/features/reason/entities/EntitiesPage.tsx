// client/src/features/reason/entities/EntitiesPage.tsx
// /entities: the companies and organisations around people (the v4 prototype's Entities screen). Your own entities
// first, with "Create your company", then a search and the others. /entities?create=1 opens the create sheet (the
// way in from elsewhere, such as "Add your company" on a profile).
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useAuthStore } from '@/stores/authStore';
import { E } from '@/realtime/entities';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import PageHead from '../ui/PageHead';
import { shouldRetry } from '../human/profile-text';
import YourEntities from './YourEntities';
import OtherEntities from './OtherEntities';
import CreateEntitySheet from './CreateEntitySheet';
import { entityKeys, fetchEntities } from './entity-api';
import { loadFailedLine, searchTerm } from './entity-text';
import { PRIMARY_BUTTON } from './look';

export default function EntitiesPage() {
  const me = useAuthStore((s) => s.user?.id as string | undefined);
  const [params, setParams] = useSearchParams();
  const creating = params.get('create') === '1';
  const [startName, setStartName] = useState('');
  const [typed, setTyped] = useState('');
  const term = searchTerm(useDebouncedValue(typed, 300));

  // The contract's tag for this list: every write that changes the member's own entities (a create, a join, a role
  // change, a leave, an edit or archive of one of them) tells them user:<me>:entities. An entity someone else adds
  // shows on the next refresh (focus, or the member's own next write).
  const list = useQuery({
    queryKey: entityKeys.list(term),
    queryFn: () => fetchEntities(term),
    enabled: !!me,
    retry: shouldRetry,
    // A new search keeps the last list on screen (dimmed) until its answer is in, instead of a skeleton per keystroke.
    placeholderData: keepPreviousData,
    meta: { entities: me ? [E.userEntities(me)] : [] },
  });

  // The sheet is open while the address says so, and opening or closing it does not add a page to the history.
  const setCreate = (open: boolean) => setParams((current) => {
    const next = new URLSearchParams(current);
    if (open) next.set('create', '1');
    else next.delete('create');
    return next;
  }, { replace: true });
  const openCreate = (name: string) => {
    setStartName(name);
    setCreate(true);
  };

  // Offline, the library holds the first request back instead of failing it: that is a failure to say, not a skeleton.
  const waiting = list.isPending && list.fetchStatus === 'paused';
  const cannotLoad = list.data === undefined && (list.isError || waiting);
  const failure = cannotLoad ? (
    <div role="alert" className="flex flex-col items-start gap-3 py-1">
      <div>
        <h3 className="text-[15px] font-bold">We could not load entities just now.</h3>
        <p className="mt-1 text-[13px] text-reason-muted">{loadFailedLine(list.error, list.fetchStatus)}</p>
      </div>
      <button type="button" onClick={() => void list.refetch()} className={PRIMARY_BUTTON}>Try again</button>
    </div>
  ) : null;

  return (
    <>
      <PageHead eyebrow="THE NETWORK AROUND PEOPLE" title="Entities" subtitle="Companies and organisations, and the people around them." pose="thinking" />
      <div className="grid gap-3.5 min-[721px]:gap-[18px]">
        <YourEntities mine={list.data?.mine ?? null} failure={failure} onCreate={() => openCreate('')} />
        {!cannotLoad && (
          <OtherEntities
            typed={typed}
            onType={setTyped}
            term={term}
            others={list.data?.others ?? null}
            mine={list.data?.mine ?? []}
            stale={list.isPlaceholderData}
            onCreate={openCreate}
          />
        )}
      </div>
      {creating && <CreateEntitySheet startName={startName} onClose={() => setCreate(false)} />}
    </>
  );
}
