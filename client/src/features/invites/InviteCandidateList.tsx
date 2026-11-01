// ─── The invite sheet's list of people (P29: split out of InvitePickerSheet.tsx, 1 Nov 2026) ─────────────────────
import type { InviteCandidate, InviteCandidateSource, InviteCandidateState } from '@rsn/shared';
import ReasonSheep from '@/features/reason/brand/ReasonSheep';
import { CONNECTION_LOST } from '@/features/reason/errors';
import Avatar from '@/components/ui/Avatar';
import { Skeleton } from '@/components/ui/Spinner';
import { cn } from '@/lib/utils';
import { LOAD_MORE_FAILED, SHOW_MORE, YOUR_CONNECTIONS, canPick, effectiveState, everyoneOnce, stateLabel } from './invite-picker';
import type { useInviteCandidates } from './useInviteCandidates';
import { BADGE, BUTTON, QUIET, type Chosen } from './invite-sheet-style';

interface ListProps {
  query: ReturnType<typeof useInviteCandidates>;
  segment: InviteCandidateSource;
  searched: string;
  podName?: string;
  sent: ReadonlyMap<string, InviteCandidateState>;
  chosen: ReadonlyMap<string, Chosen>;
  full: boolean;
  onToggle: (person: InviteCandidate) => void;
}

/** The list: loading, a refusal or no connection, nobody, or the people with "Show more". */
export default function InviteCandidateList({ query, segment, searched, podName, sent, chosen, full, onToggle }: ListProps) {
  const { data, isPending, isError, fetchStatus, refetch, hasNextPage, fetchNextPage, isFetchingNextPage, isFetchNextPageError, isPlaceholderData } = query;
  const people = everyoneOnce(data?.pages ?? []);
  const whose = segment === 'pod' ? "the pod's members" : 'your connections';

  if (data === undefined && (isError || (isPending && fetchStatus === 'paused'))) {
    return (
      <div role="alert" className="mt-3 rounded-2xl border border-reason-line p-3.5">
        <p className="text-[14px] font-bold">We could not load {whose} just now.</p>
        {fetchStatus === 'paused' && <p className="mt-1 text-[13px] text-reason-muted">{CONNECTION_LOST}</p>}
        <button type="button" onClick={() => void refetch()} className={cn(BUTTON, 'mt-3 bg-reason-red text-white hover:bg-reason-red-hover')}>Try again</button>
      </div>
    );
  }
  if (isPending) {
    return (
      <div className="mt-3 grid gap-2" aria-busy="true">
        <p className="sr-only">Loading {whose}</p>
        {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-[56px]" />)}
      </div>
    );
  }
  if (people.length === 0) {
    return (
      <div className="mt-3 flex items-start gap-3 rounded-2xl bg-reason-warm p-3.5">
        <ReasonSheep pose="hopeful" className="h-[52px] w-[52px] shrink-0" />
        <div className="min-w-0 text-[13px] text-reason-muted [overflow-wrap:anywhere]">
          {searched ? (
            <p className="font-bold text-reason-ink">Nobody in {segment === 'pod' ? 'the pod' : 'your connections'} matches “{searched}”.</p>
          ) : segment === 'pod' ? (
            <p className="font-bold text-reason-ink">Nobody else is in {podName || 'this pod'} yet.</p>
          ) : (
            <>
              <p className="font-bold text-reason-ink">No connections yet.</p>
              <p className="mt-1">When someone accepts your meeting request, or you meet at an event, they are listed here. Anyone else you can invite by email or with a link, below.</p>
            </>
          )}
        </div>
      </div>
    );
  }
  return (
    <>
      {isPlaceholderData && <p aria-live="polite" className="mt-2 text-[12px] text-reason-muted">Searching…</p>}
      <ul className="mt-2 divide-y divide-reason-line" aria-label={segment === 'pod' ? 'Members of the pod' : YOUR_CONNECTIONS}>
        {people.map((person) => (
          <CandidateRow
            key={person.userId}
            person={person}
            state={effectiveState(person, sent)}
            checked={chosen.has(person.userId)}
            full={full}
            onToggle={onToggle}
          />
        ))}
      </ul>
      {isFetchNextPageError && <p role="alert" className="mt-2 text-[13px] text-reason-muted">{LOAD_MORE_FAILED}</p>}
      {hasNextPage && (
        <div className="mt-3 flex justify-center">
          <button
            type="button"
            onClick={() => { if (!isFetchingNextPage) void fetchNextPage(); }}
            aria-disabled={isFetchingNextPage || undefined}
            className={cn(QUIET, isFetchingNextPage && 'cursor-progress')}
          >
            {isFetchingNextPage ? 'Loading more…' : SHOW_MORE}
          </button>
        </div>
      )}
    </>
  );
}

/** A person: a checkbox the whole row toggles, their name and work, and where they stand when they cannot be chosen. */
function CandidateRow({ person, state, checked, full, onToggle }: {
  person: InviteCandidate; state: InviteCandidateState; checked: boolean; full: boolean; onToggle: (person: InviteCandidate) => void;
}) {
  const label = stateLabel(state);
  const pickable = canPick(state);
  const blocked = !pickable || (!checked && full);
  const work = [person.jobTitle, person.company].filter(Boolean).join(' · ');
  return (
    <li>
      <label
        data-testid={`invite-candidate-${person.userId}`}
        className={cn('flex min-h-[56px] items-center gap-3 py-2', blocked ? 'cursor-not-allowed' : 'cursor-pointer')}
      >
        <input
          type="checkbox"
          checked={checked}
          disabled={blocked}
          onChange={() => onToggle(person)}
          className="h-5 w-5 shrink-0 accent-reason-red"
        />
        <Avatar src={person.avatarUrl} name={person.displayName} size="md" className="shrink-0" />
        <span className="min-w-0 flex-1">
          <span className={cn('block truncate text-[14px] font-bold', !pickable && 'text-[#4f5562]')}>{person.displayName}</span>
          {work && <span className="block truncate text-[12px] text-reason-muted">{work}</span>}
        </span>
        {label && <span className={cn('shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold', BADGE[state])}>{label}</span>}
      </label>
    </li>
  );
}
