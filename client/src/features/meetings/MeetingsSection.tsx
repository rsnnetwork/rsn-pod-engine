// client/src/features/meetings/MeetingsSection.tsx
// "Your meetings" on Events (26 Oct 2026, CON-04). Stefan, 25 Oct: "Now we've found a time to meet. What then? There
// should be something under Events." Every meeting two members agreed, above the events and under the same filter:
// Upcoming (soonest first), Past and Cancelled (latest first), a page at a time.
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { meetingPhase, type Meeting, type MeetingList, type MeetingScope } from '@rsn/shared';
import { Skeleton } from '@/components/ui/Spinner';
import { cn } from '@/lib/utils';
import ReasonSheep from '@/features/reason/brand/ReasonSheep';
import { CONNECTION_LOST } from '@/features/reason/errors';
import MeetingCard from './MeetingCard';
import { useMeetingList, useNow } from './useMeetings';
import { EMPTY_MEETINGS, NO_CANCELLED_MEETINGS, NO_PAST_MEETINGS, nextChangeAt } from './meeting-words';

const GRID = 'grid gap-3 min-[1024px]:grid-cols-2';
const BUTTON = 'inline-flex min-h-[44px] items-center rounded-[11px] px-4 text-[13px] font-bold';
const EMPTY: Record<MeetingScope, string> = { upcoming: EMPTY_MEETINGS, past: NO_PAST_MEETINGS, cancelled: NO_CANCELLED_MEETINGS };
// The countdown on a card ("Starts in 25 min") moves by the minute; Join itself opens at its exact moment.
const TICK_MS = 30_000;

/** The meetings of every page loaded so far, each once: a meeting moved between two pages' reads could be on both. */
function everyOnce(pages: MeetingList[]): Meeting[] {
  const seen = new Set<string>();
  return pages.flatMap((p) => p.items).filter((m) => !seen.has(m.id) && !!seen.add(m.id));
}

export default function MeetingsSection({ scope }: { scope: MeetingScope }) {
  const retrying = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const { data, isPending, isError, fetchStatus, refetch, hasNextPage, fetchNextPage, isFetchingNextPage, isFetchNextPageError } = useMeetingList(scope);
  const listed = data ? everyOnce(data.pages) : [];
  const now = useNow(TICK_MS, (at) => nextChangeAt(listed, at));
  // A meeting that closes while Upcoming is open leaves it at that moment; Past lists it the next time it is read.
  const meetings = scope === 'upcoming' ? listed.filter((m) => meetingPhase(m, now) !== 'ended') : listed;

  // Offline with nothing loaded yet is an error the member can read, not a skeleton for ever; a refresh that fails
  // while the list is on screen leaves the list as it is.
  const cannotLoad = data === undefined && (isError || (isPending && fetchStatus === 'paused'));

  // Try again goes from under the member's finger as the request starts; once the answer is in, focus goes back to
  // the section's heading, just above what replaced it.
  const tryAgain = () => { retrying.current = true; void refetch(); };
  useEffect(() => {
    if (isPending || !retrying.current) return;
    retrying.current = false;
    heading.current?.focus();
  }, [isPending, isError]);

  // One page at a time: a second press while the next page is on its way is ignored, not a second request.
  const showMore = () => { if (!isFetchingNextPage) void fetchNextPage(); };

  return (
    <section aria-labelledby="meetings-title" className="animate-fade-in-up">
      <h2 ref={heading} id="meetings-title" tabIndex={-1} className="mb-3 font-reason text-[18px] font-extrabold tracking-[-0.02em] text-reason-ink outline-none">Your meetings</h2>
      <div className="min-w-0 font-reason text-reason-ink">
        {cannotLoad ? (
          <div role="alert" className="flex flex-col items-start gap-3 rounded-2xl border border-reason-line bg-white p-4">
            <div>
              <p className="text-[15px] font-bold">We could not load your meetings just now.</p>
              {fetchStatus === 'paused' && <p className="mt-1 text-[13px] text-reason-muted">{CONNECTION_LOST}</p>}
            </div>
            <button type="button" onClick={tryAgain} className={cn(BUTTON, 'bg-reason-red text-white hover:bg-reason-red-hover')}>Try again</button>
          </div>
        ) : isPending ? (
          <div className={GRID} aria-busy="true">
            <p className="sr-only">Loading your meetings</p>
            {[0, 1].map((i) => <Skeleton key={i} className="h-[136px]" />)}
          </div>
        ) : meetings.length === 0 ? (
          <div className="flex items-start gap-3 rounded-2xl bg-reason-warm p-3.5">
            <ReasonSheep pose="hopeful" className="h-[52px] w-[52px] shrink-0" />
            <div className="min-w-0">
              <p className="text-[14px] font-bold">{EMPTY[scope]}</p>
              {scope === 'upcoming' && (
                <Link to="/messages" className={cn(BUTTON, '-ml-1 mt-1 px-1 text-reason-red-hover underline underline-offset-2')}>Open Messages</Link>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className={GRID}>
              {meetings.map((m) => <MeetingCard key={m.id} meeting={m} now={now} />)}
            </div>
            {isFetchNextPageError && (
              <p role="alert" className="mt-3 text-[13px] text-reason-muted">We could not load more just now. Try again.</p>
            )}
            {hasNextPage && (
              <div className="mt-3 flex justify-center">
                <button
                  type="button"
                  onClick={showMore}
                  aria-disabled={isFetchingNextPage || undefined}
                  className={cn(BUTTON, 'border border-reason-line bg-white text-[#2d3440] hover:bg-reason-soft', isFetchingNextPage && 'cursor-progress')}
                >
                  {isFetchingNextPage ? 'Loading more…' : 'Show more meetings'}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
