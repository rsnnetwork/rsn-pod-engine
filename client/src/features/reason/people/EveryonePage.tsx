// client/src/features/reason/people/EveryonePage.tsx
// Everyone (Stefan, 10 Nov 2026: "HOW can I connect with ANYONE, you know, just browse through"). Every member you
// may meet, A to Z, a page at a time, with a search box. Each row carries where a meeting request stands, and
// starts one through the same Meet sheet as For You.
import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { EveryoneMember } from '@rsn/shared';
import { useAuthStore } from '@/stores/authStore';
import { E } from '@/realtime/entities';
import { Skeleton } from '@/components/ui/Spinner';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { cn } from '@/lib/utils';
import PageHead from '../ui/PageHead';
import MeetSheet from '../human/MeetSheet';
import { fetchEveryone, personName, reasonKeys } from '../api';
import { CONNECTION_LOST } from '../errors';
import EveryoneCard from './EveryoneCard';

const BUTTON = 'min-h-[44px] rounded-[11px] px-4 text-[13px] font-bold';
const GRID = 'grid gap-3 min-[1024px]:grid-cols-2';

/** The people of every page loaded so far, each once: a page asked for later can repeat someone whose name changed in between. */
function everyoneOnce(pages: Array<{ people: EveryoneMember[] }>): EveryoneMember[] {
  const seen = new Set<string>();
  return pages.flatMap((p) => p.people).filter((p) => !seen.has(p.id) && !!seen.add(p.id));
}

export default function EveryonePage() {
  const userId = useAuthStore((s) => s.user?.id as string | undefined);
  const [typed, setTyped] = useState('');
  const [meeting, setMeeting] = useState<{ userId: string; displayName: string } | null>(null);
  const retrying = useRef(false);
  const content = useRef<HTMLDivElement>(null);
  const search = useDebouncedValue(typed.trim(), 300);

  const { data, isPending, isError, fetchStatus, refetch, hasNextPage, fetchNextPage, isFetchingNextPage, isFetchNextPageError } = useInfiniteQuery({
    queryKey: reasonKeys.everyone(search),
    queryFn: ({ pageParam }) => fetchEveryone(search, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: !!userId,
    // A request sent, answered or withdrawn (invites), a conversation started (dms) and a block either way (blocks)
    // change a row's state or who is listed; the member's own account (user) changes the list's owner.
    meta: { entities: userId ? [E.user(userId), E.userInvites(userId), E.userDms(userId), E.userBlocks(userId)] : [] },
  });

  const cannotLoad = data === undefined && (isError || (isPending && fetchStatus === 'paused'));
  const people = data ? everyoneOnce(data.pages) : [];
  const searching = search.length > 0;

  const tryAgain = () => { retrying.current = true; void refetch(); };
  useEffect(() => {
    if (isPending || !retrying.current) return;
    retrying.current = false;
    content.current?.querySelector<HTMLElement>('#everyone-title')?.focus();
  }, [isPending, isError]);

  const showMore = () => { if (!isFetchingNextPage) void fetchNextPage(); };
  const meet = (p: EveryoneMember) => setMeeting({ userId: p.id, displayName: personName(p.displayName) });

  return (
    <>
      <PageHead eyebrow="PEOPLE" title="Everyone" subtitle="Every member you can meet, A to Z. Search by name, company or role." pose="match" />
      <div className="mb-3">
        <label htmlFor="everyone-search" className="sr-only">Search everyone</label>
        <input
          id="everyone-search"
          type="search"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Search by name, company or role"
          maxLength={100}
          autoComplete="off"
          className="min-h-[44px] w-full rounded-[11px] border border-reason-line bg-white px-3.5 text-base text-[#1a1a2e] focus:border-reason-red focus:outline-none"
        />
      </div>
      <div ref={content} className="min-w-0">
        {cannotLoad ? (
          <div role="alert" className="flex flex-col items-start gap-3 rounded-2xl border border-reason-line bg-white p-4">
            <div>
              <h2 id="everyone-title" tabIndex={-1} className="text-[15px] font-bold outline-none">We could not load the list just now.</h2>
              {fetchStatus === 'paused' && <p className="mt-1 text-[13px] text-reason-muted">{CONNECTION_LOST}</p>}
            </div>
            <button type="button" onClick={tryAgain} className={cn(BUTTON, 'bg-reason-red text-white hover:bg-reason-red-hover')}>Try again</button>
          </div>
        ) : isPending ? (
          <div className={GRID} aria-busy="true">
            <h2 id="everyone-title" className="sr-only">Loading everyone</h2>
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[132px]" />)}
          </div>
        ) : people.length === 0 ? (
          <div className="rounded-2xl bg-reason-warm p-3.5">
            <h2 id="everyone-title" tabIndex={-1} className="text-[16px] font-bold outline-none">
              {searching ? 'No one matches that search' : 'No one to show yet'}
            </h2>
            <p className="mt-1 text-[13px] text-reason-muted">
              {searching ? 'Try a different name, company or role.' : 'Members appear here once they finish setting up their profile.'}
            </p>
            {searching && (
              <button type="button" onClick={() => setTyped('')} className={cn(BUTTON, 'mt-3 bg-reason-red text-white hover:bg-reason-red-hover')}>Clear search</button>
            )}
          </div>
        ) : (
          <>
            <h2 id="everyone-title" tabIndex={-1} className="sr-only">{searching ? 'Search results' : 'Everyone'}</h2>
            <div className={GRID}>
              {people.map((p) => <EveryoneCard key={p.id} person={p} onMeet={meet} />)}
            </div>
            {isFetchNextPageError && (
              <p role="alert" className="mt-3 text-[13px] text-reason-muted">We could not load more just now. Try again.</p>
            )}
            {hasNextPage && (
              <div className="mt-4 flex justify-center">
                <button
                  type="button"
                  onClick={showMore}
                  aria-disabled={isFetchingNextPage || undefined}
                  className={cn(BUTTON, 'border border-reason-line bg-white text-[#2d3440] hover:bg-reason-soft', isFetchingNextPage && 'cursor-progress')}
                >
                  {isFetchingNextPage ? 'Loading more…' : 'Load more'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
      <MeetSheet person={meeting} onClose={() => setMeeting(null)} />
    </>
  );
}
