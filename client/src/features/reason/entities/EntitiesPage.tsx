// client/src/features/reason/entities/EntitiesPage.tsx
// /entities: the companies and organisations around people (the v4 prototype's Entities screen). Your own entities
// first, with "Create your company", then a search and the others. /entities?create=1 opens the create sheet (the
// way in from elsewhere, such as "Add your company" on Your profile).
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

  // Two queries, so a search can never take the page away. The page's own list holds your entities and the most
  // recently active others; the search holds only the others with the words in their name. The contract's tag for
  // both: every write that changes the member's own entities (a create, a join, a role change, a leave, an edit or
  // archive of one of them) tells them user:<me>:entities. An entity someone else adds shows on the next refresh.
  const base = useQuery({
    queryKey: entityKeys.list(''),
    queryFn: () => fetchEntities(''),
    enabled: !!me,
    retry: shouldRetry,
    meta: { entities: me ? [E.userEntities(me)] : [] },
  });
  const search = useQuery({
    queryKey: entityKeys.list(term),
    queryFn: () => fetchEntities(term),
    enabled: !!me && term !== '',
    retry: shouldRetry,
    // A new search keeps the last answer on screen (dimmed) until its own is in, instead of a skeleton per keystroke.
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

  // Only the first load of the page can fail the page. Offline, the library holds that request back instead of
  // failing it: that is a failure to say, not a skeleton.
  const waiting = base.isPending && base.fetchStatus === 'paused';
  const cannotLoad = base.data === undefined && (base.isError || waiting);
  const failure = cannotLoad ? (
    <div role="alert" className="flex flex-col items-start gap-3 py-1">
      <div>
        <h3 className="text-[15px] font-bold">We could not load entities just now.</h3>
        <p className="mt-1 text-[13px] text-reason-muted">{loadFailedLine(base.error, base.fetchStatus)}</p>
      </div>
      <button type="button" onClick={() => void base.refetch()} className={PRIMARY_BUTTON}>Try again</button>
    </div>
  ) : null;

  // While a search is on its way the list on screen is the last one (the page's own, for the first search), dimmed. A
  // search that has no answer at all (failed, or held back offline) is said inside "Other entities", under its box.
  const searching = term !== '';
  const shown = searching ? search.data ?? (search.isPending ? base.data : undefined) : base.data;
  const searchFailed = searching && search.data === undefined && (search.isError || search.fetchStatus === 'paused');

  return (
    <>
      <PageHead eyebrow="THE NETWORK AROUND PEOPLE" title="Entities" subtitle="Companies and organisations, and the people around them." pose="thinking" />
      <div className="grid gap-3.5 min-[721px]:gap-[18px]">
        <YourEntities mine={base.data?.mine ?? null} failure={failure} onCreate={() => openCreate('')} />
        {!cannotLoad && (
          <OtherEntities
            typed={typed}
            onType={setTyped}
            term={term}
            others={shown?.others ?? null}
            mine={base.data?.mine ?? []}
            stale={searching && (search.isPlaceholderData || search.data === undefined)}
            searchFailure={searchFailed ? loadFailedLine(search.error, search.fetchStatus) : null}
            onRetrySearch={() => void search.refetch()}
            onCreate={openCreate}
          />
        )}
      </div>
      {creating && <CreateEntitySheet startName={startName} onClose={() => setCreate(false)} />}
    </>
  );
}
