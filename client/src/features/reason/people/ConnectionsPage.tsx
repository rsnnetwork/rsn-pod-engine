// client/src/features/reason/people/ConnectionsPage.tsx
// Your connections, the People screen's first tab (client feedback, 19 Oct 2026: "On the People page, show the
// user's own connections first"). Everyone the member is connected to or has met, newest first, a page at a
// time. Two to a row from 1024px, one list below.
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { PersonConnection } from '@rsn/shared';
import { useAuthStore } from '@/stores/authStore';
import { E } from '@/realtime/entities';
import { Skeleton } from '@/components/ui/Spinner';
import { cn } from '@/lib/utils';
import PageHead from '../ui/PageHead';
import ReasonSheep from '../brand/ReasonSheep';
import { fetchConnections, reasonKeys } from '../api';
import { CONNECTION_LOST } from '../errors';
import ConnectionCard from './ConnectionCard';

const GRID = 'grid gap-3 min-[1024px]:grid-cols-2';
const BUTTON = 'min-h-[44px] rounded-[11px] px-4 text-[13px] font-bold';

/** The people of every page loaded so far, each once: two pages asked for at different times can both hold someone whose latest date changed in between. */
function everyoneOnce(pages: Array<{ items: PersonConnection[] }>): PersonConnection[] {
  const seen = new Set<string>();
  return pages.flatMap((p) => p.items).filter((p) => !seen.has(p.userId) && !!seen.add(p.userId));
}

export default function ConnectionsPage() {
  const userId = useAuthStore((s) => s.user?.id as string | undefined);
  const retrying = useRef(false);
  const content = useRef<HTMLDivElement>(null);

  const { data, isPending, isError, fetchStatus, refetch, hasNextPage, fetchNextPage, isFetchingNextPage, isFetchNextPageError } = useInfiniteQuery({
    queryKey: reasonKeys.connections,
    queryFn: ({ pageParam }) => fetchConnections(pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    enabled: !!userId,
    // A request accepted (user, invites), a conversation started (dms), and a block either way (blocks: the server
    // tells both members) each change who is here.
    meta: { entities: userId ? [E.user(userId), E.userInvites(userId), E.userDms(userId), E.userBlocks(userId)] : [] },
  });

  // Offline with nothing loaded yet is an error the member can read, not a skeleton for ever; a refresh that fails
  // while the list is on screen leaves the list as it is (the For You page's rule).
  const cannotLoad = data === undefined && (isError || (isPending && fetchStatus === 'paused'));
  const people = data ? everyoneOnce(data.pages) : [];

  // "Try again" goes from under the member's finger as the request starts. Once the answer is in, focus goes to what
  // replaced it: the error or the empty state's heading, or the first person's name.
  const tryAgain = () => { retrying.current = true; void refetch(); };
  useEffect(() => {
    if (isPending || !retrying.current) return;
    retrying.current = false;
    const here = content.current;
    (here?.querySelector<HTMLElement>('#connections-title') ?? here?.querySelector<HTMLElement>('[data-person-id] h2 a'))?.focus();
  }, [isPending, isError]);

  // One page at a time: a second press while the next page is on its way is ignored, not a second request.
  const showMore = () => { if (!isFetchingNextPage) void fetchNextPage(); };

  return (
    <>
      <PageHead eyebrow="PEOPLE" title="Your connections" subtitle="Everyone you are connected to or have met, newest first." pose="match" />
      <div ref={content} className="min-w-0">
        {cannotLoad ? (
          <div role="alert" className="flex flex-col items-start gap-3 rounded-2xl border border-reason-line bg-white p-4">
            <div>
              <h2 id="connections-title" tabIndex={-1} className="text-[15px] font-bold outline-none">We could not load your connections just now.</h2>
              {fetchStatus === 'paused' && <p className="mt-1 text-[13px] text-reason-muted">{CONNECTION_LOST}</p>}
            </div>
            <button type="button" onClick={tryAgain} className={cn(BUTTON, 'bg-reason-red text-white hover:bg-reason-red-hover')}>Try again</button>
          </div>
        ) : isPending ? (
          <div className={GRID} aria-busy="true">
            <h2 id="connections-title" className="sr-only">Loading your connections</h2>
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[132px]" />)}
          </div>
        ) : people.length === 0 ? (
          <div className="flex items-start gap-3 rounded-2xl bg-reason-warm p-3.5">
            <ReasonSheep pose="hopeful" className="h-[58px] w-[58px] shrink-0" />
            <div className="min-w-0">
              <h2 id="connections-title" tabIndex={-1} className="text-[16px] font-bold outline-none">No connections yet.</h2>
              <p className="mt-1 text-[13px] text-reason-muted">When someone accepts your meeting request, or you meet at an event, they appear here.</p>
              <Link to="/" className={cn(BUTTON, 'mt-3 inline-flex items-center bg-reason-red text-white hover:bg-reason-red-hover')}>See who fits</Link>
            </div>
          </div>
        ) : (
          <>
            <div className={GRID}>
              {people.map((p) => <ConnectionCard key={p.userId} person={p} />)}
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
                  {isFetchingNextPage ? 'Loading more…' : 'Show more'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
